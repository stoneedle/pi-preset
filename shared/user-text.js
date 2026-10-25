/** Pi's coordinate suffix is model metadata, not part of the user's task. */
export function withoutImageCoordinates(text) {
  return text.replace(
    /(?:\s*\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d+ to map to original image\.\])+\s*$/,
    '',
  );
}
