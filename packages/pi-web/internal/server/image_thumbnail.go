package server

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"
)

// imageThumbnail bounds both decoding memory and the bytes sent for an inline preview.
// Unsupported originals remain available through the unchanged image/download URLs.
func imageThumbnail(body []byte) ([]byte, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > 40_000_000/config.Height {
		return nil, errors.New("image too large for thumbnail")
	}
	source, err := imaging.Decode(bytes.NewReader(body), imaging.AutoOrientation(true))
	if err != nil {
		return nil, err
	}
	preview := imaging.Fit(source, 240, 240, imaging.Linear)
	background := imaging.New(preview.Bounds().Dx(), preview.Bounds().Dy(), color.White)
	preview = imaging.Overlay(background, preview, image.Point{}, 1)
	var output bytes.Buffer
	if err := jpeg.Encode(&output, preview, &jpeg.Options{Quality: 75}); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
