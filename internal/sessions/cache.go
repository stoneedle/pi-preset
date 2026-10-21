package sessions

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type cacheEntry struct {
	info    os.FileInfo
	dirName string
	summary SessionSummary
}

type contentLoad struct {
	done    chan struct{}
	content *Content
	err     error
}

type Cache struct {
	mu           sync.Mutex
	entries      map[string]cacheEntry // keyed by full file path
	pathIndex    map[string]string     // filename -> full file path
	contentCache map[string]*Content
	contentLoads map[string]*contentLoad

	parses int // diagnostic: number of ParseSummary calls
	hits   int // diagnostic: number of cache hits
}

func NewCache() *Cache {
	return &Cache{
		entries:      make(map[string]cacheEntry),
		pathIndex:    make(map[string]string),
		contentCache: make(map[string]*Content),
		contentLoads: make(map[string]*contentLoad),
	}
}

// LoadAll returns summaries for every session under dir. Unchanged native file
// versions are returned from the cache; files
// that are new or modified are re-parsed; files that have disappeared are
// evicted. It also maintains a path index for O(1) lookup by filename.
func (c *Cache) LoadAll(dir string) ([]SessionSummary, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	// Collect all files to consider, along with their info, before locking.
	type fileRecord struct {
		path    string
		dirName string
		name    string
		info    os.FileInfo
	}
	var records []fileRecord
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		subDir := filepath.Join(dir, e.Name())
		subs, err := os.ReadDir(subDir)
		if err != nil {
			continue
		}
		for _, f := range subs {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			records = append(records, fileRecord{
				path:    filepath.Join(subDir, f.Name()),
				dirName: e.Name(),
				name:    f.Name(),
				info:    info,
			})
		}
	}

	c.mu.Lock()

	// Determine which files need parsing (new or modified).
	type parseWork struct {
		rec fileRecord
	}
	var toparse []parseWork
	seen := make(map[string]struct{}, len(records))
	cached := make([]SessionSummary, 0, len(records))

	for _, rec := range records {
		seen[rec.path] = struct{}{}
		if ce, ok := c.entries[rec.path]; ok && sameFileVersion(ce.info, rec.info) && ce.dirName == rec.dirName {
			c.hits++
			cached = append(cached, ce.summary)
		} else {
			toparse = append(toparse, parseWork{rec})
		}
	}

	// Evict files no longer present.
	for p := range c.entries {
		if _, ok := seen[p]; !ok {
			delete(c.entries, p)
			delete(c.pathIndex, filepath.Base(p))
		}
	}

	for path := range c.contentCache {
		if _, ok := seen[path]; !ok {
			delete(c.contentCache, path)
		}
	}
	c.mu.Unlock()

	if len(toparse) == 0 {
		SortSummariesByActivity(cached)
		return cached, nil
	}

	// Parse files concurrently.
	type result struct {
		rec     fileRecord
		summary SessionSummary
		err     error
	}
	results := make([]result, len(toparse))
	var wg sync.WaitGroup
	// Use higher concurrency — SSDs handle many concurrent reads well.
	concurrency := len(toparse)
	if concurrency > 32 {
		concurrency = 32
	}
	if concurrency < 1 {
		concurrency = 1
	}
	sem := make(chan struct{}, concurrency)
	for i, w := range toparse {
		wg.Add(1)
		go func(i int, w parseWork) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			summary, err := ParseSummary(w.rec.path, w.rec.dirName, w.rec.name)
			results[i] = result{rec: w.rec, summary: summary, err: err}
		}(i, w)
	}
	wg.Wait()

	c.mu.Lock()
	summaries := make([]SessionSummary, 0, len(records))
	summaries = append(summaries, cached...)
	for _, res := range results {
		if res.err != nil {
			continue
		}
		c.parses++
		c.entries[res.rec.path] = cacheEntry{
			info:    res.rec.info,
			dirName: res.rec.dirName,
			summary: res.summary,
		}
		c.pathIndex[res.rec.name] = res.rec.path
		summaries = append(summaries, res.summary)
	}
	// Rebuild pathIndex for all cached entries too (idempotent).
	for path, ce := range c.entries {
		name := filepath.Base(path)
		if _, exists := c.pathIndex[name]; !exists {
			c.pathIndex[name] = path
			_ = ce
		}
	}
	c.mu.Unlock()

	SortSummariesByActivity(summaries)
	return summaries, nil
}

func sameFileVersion(a, b os.FileInfo) bool {
	return a.Size() == b.Size() && a.ModTime().Equal(b.ModTime()) && os.SameFile(a, b)
}

// FindPath returns the full filesystem path for a session filename, using the
// in-memory path index built by LoadAll. Returns ("", false) if not found.
func (c *Cache) FindPath(name string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pathIndex[name]
	return p, ok
}

// resolvePath validates a native filename and uses the path index or a cold directory scan.
func (c *Cache) resolvePath(sessionsDir, id string) (string, error) {
	if id == "" || filepath.Base(id) != id || filepath.Ext(id) != ".jsonl" {
		return "", ErrInvalidSessionID
	}

	path, ok := c.FindPath(id)
	if !ok {
		var err error
		path, err = findPathByFilename(sessionsDir, id)
		if err != nil {
			return "", err
		}
		c.mu.Lock()
		c.pathIndex[id] = path
		c.mu.Unlock()
	}

	return path, nil
}

// ResolveHeader routes control without reading or parsing conversation bodies.
func (c *Cache) ResolveHeader(sessionsDir, id string) (ResolvedSession, error) {
	path, err := c.resolvePath(sessionsDir, id)
	if err != nil {
		return ResolvedSession{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return ResolvedSession{}, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	var header summaryLine
	if !scanner.Scan() || json.Unmarshal(scanner.Bytes(), &header) != nil || header.Type != "session" || header.ID == "" {
		return ResolvedSession{}, fmt.Errorf("invalid native session header")
	}
	summary := newSessionSummary(filepath.Base(filepath.Dir(path)), id)
	summary.SessionUUID = header.ID
	applySummaryContext(&summary, path, id, "", header.Name, "", header.CWD)
	return ResolvedSession{Session: Session{SessionSummary: summary, Header: map[string]any{"cwd": header.CWD}}, Path: path}, nil
}

// ResolveMetadata streams a branch-aware summary without constructing conversation bodies.
func (c *Cache) ResolveMetadata(sessionsDir, id string) (ResolvedSession, error) {
	path, err := c.resolvePath(sessionsDir, id)
	if err != nil {
		return ResolvedSession{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ResolvedSession{}, err
	}
	c.mu.Lock()
	cached, ok := c.entries[path]
	c.mu.Unlock()
	if ok && sameFileVersion(cached.info, info) {
		return ResolvedSession{Session: Session{SessionSummary: cached.summary}, Path: path}, nil
	}
	dirName := filepath.Base(filepath.Dir(path))
	summary, err := ParseSummary(path, dirName, id)
	if err != nil {
		return ResolvedSession{}, err
	}
	c.mu.Lock()
	c.entries[path] = cacheEntry{info: info, dirName: dirName, summary: summary}
	c.mu.Unlock()
	return ResolvedSession{Session: Session{SessionSummary: summary}, Path: path}, nil
}

func (c *Cache) OpenContent(sessionsDir, id string) (*Content, error) {
	path, err := c.resolvePath(sessionsDir, id)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	cached := c.contentCache[path]
	if cached != nil && sameFileVersion(cached.info, info) {
		c.mu.Unlock()
		return cached, nil
	}
	if load := c.contentLoads[path]; load != nil {
		c.mu.Unlock()
		<-load.done
		return load.content, load.err
	}
	load := &contentLoad{done: make(chan struct{})}
	c.contentLoads[path] = load
	c.mu.Unlock()

	content, err := readContentIndex(path, filepath.Base(filepath.Dir(path)), id)
	c.mu.Lock()
	if err == nil {
		c.contentCache[path] = content
	}
	load.content, load.err = content, err
	delete(c.contentLoads, path)
	close(load.done)
	c.mu.Unlock()
	return content, err
}
