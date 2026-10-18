# Test fixtures

| file | what it is |
| --- | --- |
| `lenna.jxl` | 512x512 bare codestream (`ff 0a`), XYB, 8 bit, orientation tag 1, no alpha, no animation, no boxes. The project sample: encoded with `cjxl` from the Lenna test image (Wikipedia, CC BY-SA 4.0, <https://de.wikipedia.org/wiki/Lena_(Testbild)>). |
| `lenna-container.jxl` | the same codestream in an ISOBMFF container with an `Exif` and an `xml` (XMP) box. |
| `lenna-alpha.jxl` | 256x256 with a constant 50 percent alpha extra channel (`cjxl`, default lossy settings). |
| `anim-rgb.jxl` | 64x64, three frames (red, green, blue), 77 bytes, frame durations all 0. |
| `lenna-jxlp.jxl` | `lenna-container.jxl` with the single `jxlc` box split over two `jxlp` boxes (counter 0, then counter 1 with the final bit). |
| `mkjxlp.mjs` | the script that produces `lenna-jxlp.jxl`. |

The generated fixtures are deliberately small: the tests need box, channel and animation variety,
not photographic size.

## How they were made

Run from this directory with `NATIVE` pointing at the reference binary
(`pnpm run build:native` prepares it, `djxl`/`cjxl` come from libjxl 0.12.0):

```sh
NATIVE=../../build/native/jxltran

# Exif payload: 4-byte box offset, then a minimal big-endian TIFF header with an empty IFD.
printf '\x00\x00\x00\x00MM\x00*\x00\x00\x00\x08\x00\x00' > exif.bin

# XMP payload: a minimal xmpmeta packet.
cat > xmp.xml <<'EOF'
<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" />
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
EOF

# lenna-container.jxl: bare codestream + Exif + XMP, wrapped in a container
$NATIVE --set-exif=exif.bin --set-xmp=xmp.xml --container=yes lenna.jxl lenna-container.jxl

# lenna-alpha.jxl: decode, downscale, add a constant 50 percent alpha channel, re-encode
djxl lenna.jxl lenna.png
magick lenna.png -resize 256x256 -alpha on -channel A -evaluate set 50% +channel alpha.png
cjxl alpha.png lenna-alpha.jxl

# anim-rgb.jxl: three solid colour frames as an animated GIF, then encode
magick -size 64x64 xc:red -size 64x64 xc:green -size 64x64 xc:blue -delay 25 -loop 0 anim.gif
cjxl anim.gif anim-rgb.jxl

# lenna-jxlp.jxl: split the jxlc box into two jxlp boxes
node mkjxlp.mjs lenna-container.jxl lenna-jxlp.jxl
```

Notes:

- the intermediate files (`exif.bin`, `xmp.xml`, `*.png`, `*.gif`) are not committed; the payloads
  above are complete as written,
- the GIF frame delay does not survive the `cjxl` GIF import, which is why the animation reports
  `duration=0` for every frame - the fixture only has to be animated, not watchable,
- `lenna.jxl` itself predates this README; see the table above for its origin and properties.
