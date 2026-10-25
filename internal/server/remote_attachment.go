package server

import (
	"context"
	"fmt"
	"html"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"
)

// Remote documents never inherit Pi credentials, proxies, or access to private
// networks. Resolve again at every connection, and pin the dial to the checked IP.
var attachmentClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		DialContext:           dialPublicAttachment,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxConnsPerHost:       4,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		return validateAttachmentURL(req.URL)
	},
}

func validateAttachmentURL(u *url.URL) error {
	if (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || len(u.String()) > 32768 {
		return fmt.Errorf("only public HTTP(S) attachments are supported")
	}
	return nil
}

var nonPublicAttachmentNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("::/96"),
	netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

func publicAttachmentIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, network := range nonPublicAttachmentNetworks {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func dialPublicAttachment(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("attachment host has no public address")
	}
	for _, ip := range ips {
		if !publicAttachmentIP(ip) {
			return nil, fmt.Errorf("attachments cannot access private or reserved networks")
		}
	}
	var dialer net.Dialer
	for _, ip := range ips {
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		err = dialErr
	}
	return nil, err
}

func (s *Server) handleRemoteAttachment(w http.ResponseWriter, r *http.Request, raw string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	u, err := url.Parse(raw)
	if err != nil || validateAttachmentURL(u) != nil {
		writeJSONError(w, http.StatusBadRequest, "网络附件只支持不含登录凭据的 HTTP(S) 地址。")
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "网络附件地址无效。")
		return
	}
	response, err := attachmentClient.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "无法读取网络附件，请重试或打开原文。")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		status := http.StatusBadGateway
		if response.StatusCode == http.StatusNotFound {
			status = http.StatusNotFound
		}
		writeJSONError(w, status, fmt.Sprintf("远端附件不可用（HTTP %d），请重试或打开原文。", response.StatusCode))
		return
	}
	const maxBytes = 32 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil || len(body) > maxBytes {
		writeJSONError(w, http.StatusUnprocessableEntity, "网络附件读取失败或超过 32 MiB，请打开原文。")
		return
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType == "" || mediaType == "application/octet-stream" {
		mediaType = http.DetectContentType(body)
	}
	name := path.Base(response.Request.URL.Path)
	if name == "." || name == "/" {
		name = "附件"
	}
	switch {
	case r.URL.Query().Get("thumbnail") == "1":
		body, err = imageThumbnail(body)
		if err != nil {
			writeJSONError(w, http.StatusUnprocessableEntity, "缩略图不可用，请打开原图。")
			return
		}
		mediaType = "image/jpeg"
	case r.URL.Query().Get("inline") == "1" && strings.HasPrefix(mediaType, "image/"):
		// The sandbox also protects direct navigation to SVG originals.
	case r.URL.Query().Get("preview") == "1":
		base := response.Request.URL
		origin := base.Scheme + "://" + base.Host
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline' "+origin+"; img-src "+origin+" data:; font-src "+origin+"; base-uri "+origin+"; form-action 'none'")
		switch strings.ToLower(path.Ext(name)) {
		case ".md", ".markdown":
			var document string
			document, err = markdownDocument(body, name, base.String())
			body = []byte(document)
		default:
			if mediaType == "text/html" {
				body = []byte(attachmentDocument(name, base.String(), string(body)))
			} else if strings.HasPrefix(mediaType, "text/") || mediaType == "application/json" {
				body = []byte(attachmentDocument(name, base.String(), "<pre>"+html.EscapeString(string(body))+"</pre>"))
			} else {
				writeJSONError(w, http.StatusUnsupportedMediaType, "此网络文件不支持预览，请下载或打开原文。")
				return
			}
		}
		if err != nil {
			writeJSONError(w, http.StatusUnprocessableEntity, "文档无法渲染，请下载或打开原文。")
			return
		}
		mediaType = "text/html; charset=utf-8"
	default:
		mediaType = "application/octet-stream"
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	}
	w.Header().Set("Content-Type", mediaType)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
