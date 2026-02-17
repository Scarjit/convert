
import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

interface Triangle {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
  attribute: number;
}

function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTriangles = view.getUint32(80, true);
  return bytes.length === 84 + numTriangles * 50;
}

function parseBinaryStl(bytes: Uint8Array): { header: string; triangles: Triangle[] } {
  if (bytes.length < 84) throw "Invalid binary STL: file too small.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const header = new TextDecoder("ascii").decode(bytes.slice(0, 80)).replace(/[^\x20-\x7E]/g, "").trim();
  const numTriangles = view.getUint32(80, true);
  const expectedSize = 84 + numTriangles * 50;
  if (bytes.length < expectedSize) throw "Invalid binary STL: unexpected file size.";

  const triangles: Triangle[] = [];
  for (let i = 0; i < numTriangles; i++) {
    const off = 84 + i * 50;
    const normal: [number, number, number] = [
      view.getFloat32(off, true),
      view.getFloat32(off + 4, true),
      view.getFloat32(off + 8, true),
    ];
    const vertices: [[number, number, number], [number, number, number], [number, number, number]] = [
      [view.getFloat32(off + 12, true), view.getFloat32(off + 16, true), view.getFloat32(off + 20, true)],
      [view.getFloat32(off + 24, true), view.getFloat32(off + 28, true), view.getFloat32(off + 32, true)],
      [view.getFloat32(off + 36, true), view.getFloat32(off + 40, true), view.getFloat32(off + 44, true)],
    ];
    const attribute = view.getUint16(off + 48, true);
    triangles.push({ normal, vertices, attribute });
  }

  return { header, triangles };
}

function parseAsciiStl(text: string): { name: string; triangles: Triangle[] } {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const solidMatch = lines[0]?.match(/^solid\s*(.*)/);
  if (!solidMatch) throw "Invalid ASCII STL: missing 'solid' header.";
  const name = solidMatch[1] ?? "";

  const triangles: Triangle[] = [];
  let i = 1;
  while (i < lines.length) {
    if (lines[i].startsWith("endsolid")) break;

    const normalMatch = lines[i].match(/facet\s+normal\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/);
    if (!normalMatch) throw `Invalid ASCII STL at line ${i + 1}: expected 'facet normal'.`;
    const normal: [number, number, number] = [
      parseFloat(normalMatch[1]), parseFloat(normalMatch[2]), parseFloat(normalMatch[3]),
    ];
    i++; // outer loop
    if (!lines[i]?.match(/outer\s+loop/)) throw `Invalid ASCII STL at line ${i + 1}: expected 'outer loop'.`;
    i++;

    const vertices: [number, number, number][] = [];
    for (let v = 0; v < 3; v++) {
      const vertexMatch = lines[i]?.match(/vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/);
      if (!vertexMatch) throw `Invalid ASCII STL at line ${i + 1}: expected 'vertex'.`;
      vertices.push([parseFloat(vertexMatch[1]), parseFloat(vertexMatch[2]), parseFloat(vertexMatch[3])]);
      i++;
    }

    if (!lines[i]?.match(/endloop/)) throw `Invalid ASCII STL at line ${i + 1}: expected 'endloop'.`;
    i++;
    if (!lines[i]?.match(/endfacet/)) throw `Invalid ASCII STL at line ${i + 1}: expected 'endfacet'.`;
    i++;

    triangles.push({
      normal,
      vertices: vertices as [[number, number, number], [number, number, number], [number, number, number]],
      attribute: 0,
    });
  }

  return { name, triangles };
}

function trianglesToAscii(name: string, triangles: Triangle[]): string {
  const lines: string[] = [`solid ${name}`];
  for (const tri of triangles) {
    lines.push(`  facet normal ${tri.normal[0]} ${tri.normal[1]} ${tri.normal[2]}`);
    lines.push("    outer loop");
    for (const v of tri.vertices) {
      lines.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`);
    }
    lines.push("    endloop");
    lines.push("  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return lines.join("\n") + "\n";
}

function trianglesToBinary(header: string, triangles: Triangle[]): Uint8Array {
  const buf = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buf);
  const headerBytes = new TextEncoder().encode(header.slice(0, 80).padEnd(80, "\0"));
  new Uint8Array(buf).set(headerBytes, 0);
  view.setUint32(80, triangles.length, true);

  for (let i = 0; i < triangles.length; i++) {
    const off = 84 + i * 50;
    const tri = triangles[i];
    view.setFloat32(off, tri.normal[0], true);
    view.setFloat32(off + 4, tri.normal[1], true);
    view.setFloat32(off + 8, tri.normal[2], true);
    for (let v = 0; v < 3; v++) {
      view.setFloat32(off + 12 + v * 12, tri.vertices[v][0], true);
      view.setFloat32(off + 12 + v * 12 + 4, tri.vertices[v][1], true);
      view.setFloat32(off + 12 + v * 12 + 8, tri.vertices[v][2], true);
    }
    view.setUint16(off + 48, tri.attribute, true);
  }

  return new Uint8Array(buf);
}

/** Auto-detect and parse an STL file (binary or ASCII). */
function parseStl(bytes: Uint8Array): { name: string; triangles: Triangle[] } {
  if (isBinaryStl(bytes)) {
    const { header, triangles } = parseBinaryStl(bytes);
    return { name: header, triangles };
  }
  const text = new TextDecoder().decode(bytes);
  return parseAsciiStl(text);
}

class threeDModelHandler implements FormatHandler {

  public name: string = "3dModel";
  public supportedFormats: FileFormat[] = [];
  public ready: boolean = false;

  async init() {
    this.supportedFormats = [
      {
        name: "Stereolithography Binary",
        format: "stl",
        extension: "stl",
        mime: "model/x.stl-binary",
        from: true,
        to: true,
        internal: "stl",
      },
      {
        name: "Stereolithography ASCII",
        format: "stla",
        extension: "stla",
        mime: "text/plain",
        from: true,
        to: true,
        internal: "stl_ascii",
      },
    ];
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];

    for (const file of inputFiles) {
      const baseName = file.name.split(".").slice(0, -1).join(".") || file.name;
      const outName = baseName + "." + outputFormat.extension;
      const raw = new Uint8Array(file.bytes);
      let outBytes: Uint8Array;

      const outFmt = outputFormat.internal;

      // Always auto-detect the input regardless of what format label says
      const { name, triangles } = parseStl(raw);

      if (outFmt === "stl_ascii") {
        outBytes = new Uint8Array(new TextEncoder().encode(trianglesToAscii(name, triangles)));
      } else if (outFmt === "stl") {
        outBytes = trianglesToBinary(name, triangles);
      } else {
        throw `Unsupported output format: ${outFmt}`;
      }

      outputFiles.push({ name: outName, bytes: outBytes });
    }

    return outputFiles;
  }

}

export default threeDModelHandler;
