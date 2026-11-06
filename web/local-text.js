'use strict';
// 文件选择器和本机服务共用同一套中文解码规则，限长读取时允许末尾字符不完整。
(function (root) {
  function decode(bytes, partial = false) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let encoding;
    if (data[0] === 0xff && data[1] === 0xfe) encoding = 'utf-16le';
    else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'utf-16be';
    else if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) encoding = 'utf-8';
    else if (data.length >= 4 && data[1] === 0 && data[3] === 0) encoding = 'utf-16le';
    else if (data.length >= 4 && data[0] === 0 && data[2] === 0) encoding = 'utf-16be';
    else {
      const header = new TextDecoder('windows-1252').decode(data.subarray(0, 200));
      if (/<\?xml\b[^>]*encoding=["'](?:gb2312|gbk|gb18030|cp936)["']/i.test(header)) encoding = 'gb18030';
    }
    const read = name => new TextDecoder(name, {fatal: true}).decode(data, {stream: partial});
    if (encoding) return read(encoding);
    try { return read('utf-8'); }
    catch { try { return read('gb18030'); } catch { throw Error('文件文字编码无法识别，请另存为 UTF-8 后重试'); } }
  }
  if (typeof module === 'object' && module.exports) module.exports = {decode};
  else root.BenchText = {decode};
})(globalThis);
