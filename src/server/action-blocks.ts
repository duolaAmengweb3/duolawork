export function actionBlocks(text: string, pattern: RegExp) {
  let fence = '';
  const masked = text
    .split('\n')
    .map((line) => {
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence || delimiter) {
        if (!fence) fence = delimiter![1];
        else if (
          delimiter &&
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = '';
        return line.replace(/</g, '\x00');
      }
      return line.replace(/(`+)(.+?)\1/g, (span) => span.replace(/</g, '\x00'));
    })
    .join('\n');
  const matches = Array.from(masked.matchAll(new RegExp(pattern.source, pattern.flags + 'd')));
  const pieces: string[] = [];
  let offset = 0;
  for (const match of matches) {
    pieces.push(text.slice(offset, match.index));
    offset = match.index + match[0].length;
    match.indices!.forEach((range, i) => {
      if (range) match[i] = text.slice(...range);
    });
  }
  pieces.push(text.slice(offset));
  return { matches, cleaned: pieces.join('').trim() };
}
