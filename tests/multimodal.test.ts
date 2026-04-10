import { describe, expect, it } from "bun:test";
import { extractImageUrls } from "../src/utils/multimodal.js";

describe("extractImageUrls", () => {
  it("returns empty array for empty string", () => {
    expect(extractImageUrls("")).toEqual([]);
  });

  it("extracts and dedupes markdown + direct URLs", () => {
    const text =
      "Here is an image ![alt](https://example.com/a.png) and another " +
      "![](https://example.com/b.JPG?size=large) plus a repeat https://example.com/a.png";
    expect(extractImageUrls(text)).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.JPG?size=large",
    ]);
  });

  it("ignores non-image URLs", () => {
    const text = "Not images: https://example.com/file.pdf and https://example.com/noext";
    expect(extractImageUrls(text)).toEqual([]);
  });

  it("extracts markdown syntax images", () => {
    const text = "Check out this screenshot: ![Screenshot](https://example.com/screenshot.png)";
    expect(extractImageUrls(text)).toEqual(["https://example.com/screenshot.png"]);
  });

  it("extracts direct image links", () => {
    const text =
      "Direct link: https://example.com/photo.jpg and another https://example.com/image.gif";
    expect(extractImageUrls(text)).toEqual([
      "https://example.com/photo.jpg",
      "https://example.com/image.gif",
    ]);
  });

  it("handles various image formats", () => {
    const text =
      "Multiple formats: " +
      "https://example.com/image.png " +
      "https://example.com/photo.jpeg " +
      "https://example.com/pic.gif " +
      "https://example.com/img.webp " +
      "https://example.com/bitmap.bmp " +
      "https://example.com/scan.tiff";
    expect(extractImageUrls(text)).toEqual([
      "https://example.com/image.png",
      "https://example.com/photo.jpeg",
      "https://example.com/pic.gif",
      "https://example.com/img.webp",
      "https://example.com/bitmap.bmp",
      "https://example.com/scan.tiff",
    ]);
  });

  it("handles URLs with query params", () => {
    const text = "Image with params: https://cdn.example.com/image.png?width=800&height=600";
    expect(extractImageUrls(text)).toEqual([
      "https://cdn.example.com/image.png?width=800&height=600",
    ]);
  });

  it("is case insensitive", () => {
    const text = "Mixed case: https://example.com/Image.PNG and https://example.com/photo.JpEg";
    expect(extractImageUrls(text)).toEqual([
      "https://example.com/Image.PNG",
      "https://example.com/photo.JpEg",
    ]);
  });

  it("deduplicates repeated URLs", () => {
    const text =
      "Same URL twice: https://example.com/image.png and again https://example.com/image.png";
    expect(extractImageUrls(text)).toEqual(["https://example.com/image.png"]);
  });

  it("handles mixed markdown and direct links", () => {
    const text =
      "Markdown: ![alt text](https://example.com/markdown.png) " +
      "and direct: https://example.com/direct.jpg " +
      "and another markdown ![](https://example.com/another.gif)";
    const result = extractImageUrls(text);
    expect(new Set(result)).toEqual(
      new Set([
        "https://example.com/markdown.png",
        "https://example.com/direct.jpg",
        "https://example.com/another.gif",
      ]),
    );
    expect(result.length).toBe(3);
  });
});
