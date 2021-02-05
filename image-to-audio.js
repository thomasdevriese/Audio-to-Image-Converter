const C = require('construct-js');
const fs = require('fs');
const path = require('path');
const PNG = require('pngjs').PNG;

const filepath = process.argv[2];
if(!filepath){
  printErr();
}
const regex = /^(?:[\w-() ]+\/)*([\w-() ]+)\.png$/i;
const matches = filepath.match(regex);
if(!matches){
  printErr();
}
const filename = matches[1].slice(-8) == '_encoded' ? matches[1].slice(0,-8) : matches[1];

let numberOfEncodedLines, numberOfChannels, bitsPerSample, sampleRate, audioFormat;

fs.createReadStream(filepath)
  .pipe(
    new PNG({
      filterType: 4,
    })
  )
  .on("parsed", function () {
    /*
    Header (eerste lijn uit afbeelding) parsen. Enkel eerste 5 pixels zijn nodig (dus 20 rgba waarden).
    */
    numberOfEncodedLines = this.data.slice(0,4).readUInt32BE();
    numberOfChannels = this.data.slice(4,8).readUInt32BE();
    bitsPerSample = this.data.slice(8,12).readUInt32BE();
    sampleRate = this.data.slice(12,16).readUInt32BE();
    audioFormat = this.data.slice(16,20).readUInt32BE();
    if((numberOfChannels < 1 || numberOfChannels > 2) || (bitsPerSample != 16 && bitsPerSample != 32) || (audioFormat != 1 && audioFormat != 3)){
      console.error('Error: invalid data. Use a correctly encoded image.');
      process.exit(1);
    }
    console.log(`Header: ${numberOfEncodedLines},${numberOfChannels},${bitsPerSample},${sampleRate},${audioFormat}`);
    /*
    Controleren op stereo.
    */
    const stereo = numberOfChannels == 2 ? true : false;
    /*
    Loop over alle pixels, bereken amplitude op basis van rgba waarden van pixel en steek amplitude in array.
    Beginnen bij y = 1 want eerste lijn is header.
    */
    let soundData = [];
    for (let y = 1; y <= numberOfEncodedLines; (stereo ? y+=2 : y++)) {
      for (let x = 0; x < this.width; x++) {
        let index = (y * this.width + x) << 2;

        let r = this.data[index] & 0xFF;
        let g = this.data[index + 1] & 0xFF;
        let b = this.data[index + 2] & 0xFF;
        let a = this.data[index + 3] & 0xFF;

        /*
        RGBA waarden omvormen naar een unsigned 16-bit of 32-bit getal.
        */
        let rgba;
        if(bitsPerSample == 16){
          rgba = (b << 8 >>> 0) + (a);
        } else {
          rgba = (r << 24 >>> 0) + (g << 16) + (b << 8) + (a);
        }
        /*
        Terug herleiden naar getal tussen -32768 en 32768 (signed 16-bit getal) of tussen -2147483648 en 2147483647 (signed 32-bit getal), om amplitude van geluidsgolf voor te stellen.
        */
        let amplitude = rgba - (bitsPerSample == 16 ? 32768 : 2147483648);
        soundData.push(amplitude);

        /*
        In een stereo wav bestand worden de samples van de 2 kanalen samengevoegd in een eendimensionele array.
        Daarin zijn de samples afwisselend van kanaal 1 en kanaal 2.
        */
        if(stereo){
          let index2 = ((y+1) * this.width + x) << 2;

          let r2 = this.data[index2] & 0xFF;
          let g2 = this.data[index2 + 1] & 0xFF;
          let b2 = this.data[index2 + 2] & 0xFF;
          let a2 = this.data[index2 + 3] & 0xFF;
          let rgba2;
          if(bitsPerSample == 16){
            rgba2 = (b2 << 8 >>> 0) + (a2);
          } else {
            rgba2 = (r2 << 24 >>> 0) + (g2 << 16) + (b2 << 8) + (a2);
          }
          let amplitude2 = rgba2 - (bitsPerSample == 16 ? 32768 : 2147483648);
          soundData.push(amplitude2);
        }
      }
    }
    console.log(`Samples: ${soundData.slice(0,stereo ? 6 : 3)},...`);

    /*
    Zou moeten gelijk zijn aan Math.Ceil(Math.sqrt(<origineel-aantal-samples>))².
    */
    console.log(`Aantal samples (1 kanaal): ${stereo ? soundData.length/2 : soundData.length}`);

    createWav(soundData, stereo, numberOfChannels, bitsPerSample, sampleRate, audioFormat);
  });

function createWav(soundData, stereo, numberOfChannels, bitsPerSample, sampleRate, audioFormat){
  const riffChunkStruct = C.Struct('riffChunk')
    .field('magic', C.RawString('RIFF'))
    .field('size', C.U32LE(0))
    .field('fmtName', C.RawString('WAVE'));

  const fmtSubChunkStruct = C.Struct('fmtSubChunk')
    .field('id', C.RawString('fmt '))
    .field('subChunk1Size', C.U32LE(0))
    .field('audioFormat', C.U16LE(audioFormat))
    .field('numChannels', C.U16LE(numberOfChannels))
    .field('sampleRate', C.U32LE(sampleRate))
    .field('byteRate', C.U32LE(sampleRate * numberOfChannels * bitsPerSample/8))
    .field('blockAlign', C.U16LE(numberOfChannels * bitsPerSample/8))
    .field('bitsPerSample', C.U16LE(bitsPerSample));
  const totalSubChunkSize = fmtSubChunkStruct.computeBufferSize();
  fmtSubChunkStruct.get('subChunk1Size').set(totalSubChunkSize - 8);

  const dataSubChunkStruct = C.Struct('dataSubChunk')
    .field('id', C.RawString('data'))
    .field('size', C.U32LE(0))
    .field('data', bitsPerSample == 16 ? C.S16LEs([0]) : C.S32LEs([0]));

  dataSubChunkStruct.get('data').set(soundData);
  /*
  Je hoeft hier niet te controleren op aantal channels, een stereo soundData array is sowieso al dubbel zo groot.
  */
  dataSubChunkStruct.get('size').set(soundData.length * bitsPerSample/8);
  riffChunkStruct.get('size').set(36 + dataSubChunkStruct.get('size').raw[0]);

  const fileStruct = C.Struct('waveFile')
    .field('riffChunk', riffChunkStruct)
    .field('fmtSubChunk', fmtSubChunkStruct)
    .field('dataSubChunk', dataSubChunkStruct);
  
  const output = `reconstructed/${filename}_reconstructed.wav`;

  fs.writeFileSync(path.join(__dirname, output),
      fileStruct.toBuffer());

  console.log(`\nImage converted to ${stereo ? 'stereo' : 'mono'} audio ${output}`);
}

function printErr(){
  console.error('USAGE: node image-to-audio <REL-PATH-TO-IMAGE>.png');
  process.exit(1);
}
