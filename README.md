# Audio-to-Image-Converter
Encodes a WAV file into a PNG file, or reversed. You can optionally encode on top of an existing PNG file.
## Usage
### Convert audio to image
`node audio-to-image <REL-PATH-TO-AUDIO>.wav [<REL-PATH-TO-IMAGE>.png]`

The optional relative path to an image is to allow for the encoding of audio on top of an existing image.
### Convert image to audio
`node image-to-audio <REL-PATH-TO-IMAGE>.png`
