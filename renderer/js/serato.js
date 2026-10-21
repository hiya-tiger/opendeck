(function () {
  const DJ = (window.DJ = window.DJ || {});

  const decoders = {
    le: new TextDecoder("utf-16le"),
    be: new TextDecoder("utf-16be"),
  };

  function utf16Order(bytes, start, end) {
    const limit = Math.min(end, start + 64);
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = start; i < limit; i++) {
      if (bytes[i] !== 0) continue;
      if ((i - start) % 2 === 0) evenZeros++;
      else oddZeros++;
    }
    if (evenZeros === oddZeros) return "le";
    return evenZeros > oddZeros ? "be" : "le";
  }
  const PATH_TAGS = new Set(["ptrk", "pfil"]);

  function tagAt(bytes, offset) {
    let tag = "";
    for (let i = 0; i < 4; i++) {
      const code = bytes[offset + i];
      if (code < 0x20 || code > 0x7e) return null;
      tag += String.fromCharCode(code);
    }
    return tag;
  }

  function readBlocks(bytes, start, end) {
    const blocks = [];
    let offset = start;
    while (offset + 8 <= end) {
      const tag = tagAt(bytes, offset);
      if (!tag) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      const length = view.getUint32(4, false);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + length;
      if (length < 0 || payloadEnd > end) break;
      blocks.push({ tag, start: payloadStart, end: payloadEnd });
      offset = payloadEnd;
    }
    return blocks;
  }

  function looksLikeBlocks(bytes, start, end) {
    if (end - start < 8) return false;
    const tag = tagAt(bytes, start);
    if (!tag || !/^[a-z0-9]{4}$/.test(tag)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, 8);
    const length = view.getUint32(4, false);
    return length <= end - start - 8;
  }

  function decodePath(bytes, start, end) {
    if (end - start < 2) return "";
    const order = utf16Order(bytes, start, end);
    const text = decoders[order].decode(bytes.subarray(start, end));
    return text.replace(/\0+$/, "").trim();
  }

  function collectPaths(bytes, blocks, out) {
    for (const block of blocks) {
      if (PATH_TAGS.has(block.tag)) {
        const value = decodePath(bytes, block.start, block.end);
        if (value) out.push(value);
        continue;
      }
      if (looksLikeBlocks(bytes, block.start, block.end)) {
        collectPaths(bytes, readBlocks(bytes, block.start, block.end), out);
      }
    }
  }

  function normalize(path) {
    return path
      .replace(/^file:\/\/localhost\//i, "")
      .replace(/^file:\/\//i, "")
      .replace(/\\/g, "/");
  }

  function fileName(path) {
    const normalized = normalize(path);
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : normalized;
  }

  function parse(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const blocks = readBlocks(bytes, 0, bytes.length);

    let version = "";
    for (const block of blocks) {
      if (block.tag === "vrsn") version = decodePath(bytes, block.start, block.end);
    }

    const raw = [];
    collectPaths(bytes, blocks, raw);

    const seen = new Set();
    const tracks = [];
    for (const path of raw) {
      const key = normalize(path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({ path: normalize(path), name: fileName(path) });
    }

    const tags = new Set();
    const walk = (list) => {
      for (const block of list) {
        tags.add(block.tag);
        if (looksLikeBlocks(bytes, block.start, block.end)) {
          walk(readBlocks(bytes, block.start, block.end));
        }
      }
    };
    walk(blocks);

    return { version, tracks, tags: Array.from(tags).sort() };
  }

  function isSerato(input) {
    try {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (bytes.length < 12) return false;
      return tagAt(bytes, 0) === "vrsn";
    } catch {
      return false;
    }
  }

  DJ.serato = { parse, isSerato, normalize };
})();
