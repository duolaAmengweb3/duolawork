// Repair a common LLM formatting slip only for an unmistakable document
// hierarchy. A single social hashtag or content inside code stays untouched.
export function presentationMarkdown(body){
 const lines=String(body).split('\n'),first=lines.find(line=>line.trim());
 if(!/^#(?!#)\S/.test(first||'')||!lines.some(line=>/^##(?!#)\S/.test(line)))return body;
 let fence=null;
 return lines.map(line=>{const match=line.match(/^\s*(\x60{3,}|~{3,})/);if(match){const mark=match[1][0];if(!fence)fence=mark;else if(fence===mark)fence=null;return line;}return fence?line:line.replace(/^(#{1,6})(?=[^\s#])/,'$1 ');}).join('\n');
}
