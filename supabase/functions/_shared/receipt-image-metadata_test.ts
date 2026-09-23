import { editedBySoftware } from "./receipt-image-metadata.ts";
const enc = new TextEncoder();
function png(type: string, text: string) {
  const data = enc.encode(text), out = new Uint8Array(20 + data.length);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  new DataView(out.buffer).setUint32(8, data.length);
  out.set(enc.encode(type), 12);
  out.set(data, 16);
  return out;
}
Deno.test("editor words in compressed PNG pixels are not metadata", async () => {
  if (
    await editedBySoftware(png("IDAT", "random gimp pixels Adobe Photoshop"))
  ) throw Error("False positive");
});
Deno.test("actual editor metadata remains flagged", async () => {
  if (!await editedBySoftware(png("tEXt", "Software\0GIMP"))) {
    throw Error("Missed editor");
  }
});
Deno.test("normal image metadata and truncated chunks remain safe", async () => {
  if (await editedBySoftware(png("tEXt", "Software\0iOS"))) {
    throw Error("False positive");
  }
  if (await editedBySoftware(png("tEXt", "Software\0GIMP").slice(0, 18))) {
    throw Error("Read truncated data");
  }
});
Deno.test("JPEG scan bytes are never searched for editor words", async () => {
  const b = new Uint8Array([255, 216, 255, 218, ...enc.encode("gimp")]);
  if (await editedBySoftware(b)) throw Error("False positive");
});
Deno.test("JPEG EXIF editor metadata remains flagged", async () => {
  const data = enc.encode("Exif\0Software\0Adobe Photoshop");
  const b = new Uint8Array(6 + data.length);
  b.set([255, 216, 255, 225]);
  new DataView(b.buffer).setUint16(4, data.length + 2);
  b.set(data, 6);
  if (!await editedBySoftware(b)) throw Error("Missed editor");
});
