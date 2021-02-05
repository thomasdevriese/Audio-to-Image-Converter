const A = require('arcsecond');
const B = require('arcsecond-binary');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const PNG = require('pngjs').PNG;

/*
Filenames van commandline args nemen, indien verkeerde syntax of extensie, print error en exit.
Ook controleren of we data toevoegen aan een bestaande afbeelding, of een nieuwe afbeelding maken.
*/
const filepathWAV = process.argv[2];
if(!filepathWAV){
  printErr();
}
const regexWAV = /^(?:[\w-() ]+\/)*([\w-() ]+)\.wav$/i;
const matchesWAV = filepathWAV.match(regexWAV);
if(!matchesWAV){
  printErr();
}
const filenameWAV = matchesWAV[1];

const filepathPNG = process.argv[3];
let filenamePNG;
let addToExistingImage = false;
if(filepathPNG){
  const regexPNG = /^(?:[\w-() ]+\/)*([\w-() ]+)\.png$/i;
  const matchesPNG = filepathPNG.match(regexPNG);
  if(!matchesPNG){
    printErr();
  }
  addToExistingImage = true;
  filenamePNG = matchesPNG[1];
}

/*
Wav bestand inlezen.
*/
const file = fs.readFileSync(path.join(__dirname, `./${filepathWAV}`));

/*
https://www.youtube.com/watch?v=udbA7u1zYfc
*/
const riffChunkSize = B.u32LE.chain(size => {
  if (size !== file.length - 8) {
    return A.fail(`Invalid file size: ${file.length}. Expected ${size}`);
  }
  return A.succeedWith(size);
});

const riffChunk = A.sequenceOf([
  A.str('RIFF'),
  riffChunkSize,
  A.str('WAVE')
]);

const fmtSubChunk = A.coroutine(function* () {
  const id = yield A.str('fmt ');
  const subChunk1Size = yield B.u32LE;
  const audioFormat = yield B.u16LE;
  const numChannels = yield B.u16LE;
  const sampleRate = yield B.u32LE;
  const byteRate = yield B.u32LE;
  const blockAlign = yield B.u16LE;
  const bitsPerSample = yield B.u16LE;

  const expectedByteRate = sampleRate * numChannels * bitsPerSample / 8;
  if (byteRate !== expectedByteRate) {
    yield A.fail(`Invalid byte rate: ${byteRate}, expected ${expectedByteRate}`);
  }

  const expectedBlockAlign = numChannels * bitsPerSample / 8;
  if (blockAlign !== expectedBlockAlign) {
    yield A.fail(`Invalid block align: ${blockAlign}, expected ${expectedBlockAlign}`);
  }

  const fmtChunkData = {
    id,
    subChunk1Size,
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample
  };

  yield A.setData(fmtChunkData);
  return fmtChunkData;
});

const dataSubChunk = A.coroutine(function* () {
  const id = yield A.str('data');
  const size = yield B.u32LE;

  const fmtData = yield A.getData;

  const samples = size / fmtData.numChannels / (fmtData.bitsPerSample / 8);
  const channelData = Array.from({length: fmtData.numChannels}, () => []);

  let sampleParser;
  if (fmtData.bitsPerSample === 8) {
    sampleParser = B.s8;
  } else if (fmtData.bitsPerSample === 16) {
    sampleParser = B.s16LE;
  } else if (fmtData.bitsPerSample === 32) {
    sampleParser = B.s32LE;
  } else {
    yield A.fail(`Unsupported bits per sample: ${fmtData.bitsPerSample}`);
  }

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
    for (let i = 0; i < fmtData.numChannels; i++) {
      const sampleValue = yield sampleParser;
      channelData[i].push(sampleValue);
    }
  }

  return {
    id,
    size,
    samples,
    channelData
  };
});

const parser = A.sequenceOf([
  riffChunk,
  fmtSubChunk,
  dataSubChunk,
  // A.endOfInput
]).map(([riffChunk, fmtSubChunk, dataSubChunk]) => ({
  riffChunk,
  fmtSubChunk,
  dataSubChunk
}));

const output = parser.run(file.buffer);
if (output.isError) {
  throw new Error(output.error);
}

console.log(output.result);

/*
In sampleArray komen alle samples (dus opeenvolgende integers die de amplitude van de geluidsgolf voorstellen).
Indien stereo: channelData[0] --> linkerkanaal, channelData[1] --> rechterkanaal.
Indien mono: channelData[0] --> monokanaal.
*/
let sampleArray = output.result.dataSubChunk.channelData;
const audioFormat = output.result.fmtSubChunk.audioFormat;
const numberOfChannels = output.result.fmtSubChunk.numChannels;
const sampleRate = output.result.fmtSubChunk.sampleRate;
const bitsPerSample = output.result.fmtSubChunk.bitsPerSample;

if(numberOfChannels == 0 || numberOfChannels > 2){
  console.error(`Error: unsupported number of channels.`);
  process.exit(1);
}

if(bitsPerSample != 16 && bitsPerSample != 32){
  console.error(`Error: unsupported number of bits per sample.`);
  process.exit(1);
}

/*
Controleren of audio mono of stereo is.
*/
const stereo = numberOfChannels == 2 ? true : false;

/*
Eventuele stilte in begin van audio overslaan.
*/
if(!stereo){
  let currentSample = sampleArray[0][0];
  while(currentSample == 0){
    sampleArray[0].shift();
    currentSample = sampleArray[0][0];
  }
} else {
  let currentSampleLeft = sampleArray[0][0];
  let currentSampleRight = sampleArray[1][0];
  while(currentSampleLeft == 0 && currentSampleRight == 0){
    sampleArray[0].shift();
    sampleArray[1].shift();
    currentSampleLeft = sampleArray[0][0];
    currentSampleRight = sampleArray[1][0];
  }
}

const numberOfSamples = sampleArray[0].length;
console.log(`Aantal samples (1 kanaal) na verwijderen initiële stilte: ${numberOfSamples} `);

/*
Eerste 3 values van linkerkanaal van sampleArray:
*/
console.log(`Samples: ${sampleArray[0].slice(0,3)},...`);

/*
SampleArray omzetten naar / toevoegen aan afbeelding.
*/

let numberOfEncodedLines = 0;
let originalImageData = [];
let width = 0;
let height = 0;

if(addToExistingImage){
  fs.createReadStream(filepathPNG)
    .pipe(
      new PNG({
        filterType: 4,
      })
    )
    .on("parsed", function () {
      /*
      Aantal geëncodeerde lijnen pixels berekenen om dan in header te steken, zodat bij het decoderen van de afbeelding enkel het geëncodeerde stuk bekeken wordt. De rest van de afbeelding moet gerust gelaten worden.
      */
      numberOfEncodedLines = Math.ceil((stereo ? 2 : 1) * numberOfSamples/this.width);
      console.log(`Number of encoded lines: ${numberOfEncodedLines}`);
      /*
      Breedte van de nieuwe afbeelding zal zelfde zijn als die van de originele.
      Hoogte = hoogte van de originele afbeelding + aantal geëncodeerde lijnen + 1 (voor header).
      Bij stereo zijn er dubbel zoveel geëncodeerde lijnen in de afbeelding aangezien er voor het 2de kanaal nog eens evenveel lijnen moeten zijn.
      Zo bekomen we een rechthoekig geëncodeerd stuk met width*height aantal pixels, wat gelijk is aan het aantal samples.
      */
      width = this.width;
      height = this.height + numberOfEncodedLines + 1;
      /*
      Loop over alle pixels, bereken 32-bit getal op basis van rgba waarden van pixel en steek getallen van hele lijn in rowData. RowData komt dan op zijn beurt in de 2-dimensionele array originalImageData. De 32-bit getallen zijn nodig om mee te geven aan Jimp, die dan opnieuw een afbeelding zal samenstellen bestaande uit de data van de audiofile + de originalImageData.
      */
      let rowData = [];
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          let index = (y * this.width + x) << 2;

          let r = this.data[index] & 0xFF;
          let g = this.data[index + 1] & 0xFF;
          let b = this.data[index + 2] & 0xFF;
          let a = this.data[index + 3] & 0xFF;

          /*
          Rgba waarden omvormen naar een unsigned 32-bit getal.
          */
          let rgba = (r << 24 >>> 0) + (g << 16) + (b << 8) + (a);

          rowData.push(rgba);
        }
        originalImageData.push(rowData);
        rowData = [];
      }
      console.log(`Original image data: ${originalImageData[0].slice(0,3)},...`);

      createImage();
    });
} else {
  /*
  Width van de afbeelding is de vierkantswortel van het aantal samples, naar boven afgerond.
  Height is ofwel gelijk aan width (mono) ofwel 2*width (stereo) + 1 voor header.
  Bij stereo zijn er dubbel zoveel lijnen in de afbeelding aangezien er voor het 2de kanaal nog eens evenveel lijnen moeten zijn.
  Zo bekomen we een rechthoekige afbeelding met width*height aantal pixels, wat gelijk is aan het aantal samples.
  Er moet afgerond worden naar boven omdat die vierkantswortel meestal een kommagetal is, en je kan niet bv 300,21 pixels hebben.
  Dat betekent dus dat de laatste lijn pixels in de afbeelding meestal niet volledig opgevuld zal zijn met data.
  */
  width = Math.ceil(Math.sqrt(numberOfSamples));
  numberOfEncodedLines = (stereo ? 2*width : width);
  height = numberOfEncodedLines + 1;

  createImage();
}

function createImage(){
  console.log(`Width: ${width}, height: ${height}`);
  let header = createHeader();
  console.log(`Header: ${header.slice(0,8)},...`);
  /*
  ImageData = 2-dimensionele array waarin header, amplitudes en originele image data opgeslagen zullen worden(die dan door de Jimp package omgezet worden naar rgba waarden voor pixels), per rij 1 array.
  */
  let imageData = [];
  imageData.push(header);
  /*
  RowData = data voor 1 rij in de afbeelding.
  */
  let rowData = [];
  /*
  De afbeelding pixel per pixel berekenen in een loop.
  */
  let channel = 0;
  for(let y = 0; y < numberOfEncodedLines; y++) {
    if(stereo){
      channel = y%2;
    }
    for(let x = 0; x < width; x++) {
      /*
      Positie in sampleArray gebaseerd op x en y + controleren als het stereo is en voor welk kanaal we bezig zijn.
      */
      let posSampleArray = (stereo ? (channel ? (y-1)/2 : y/2) : y) * width + x;
      /*
      Amplitude herleiden naar waarde tussen 0 en 65535 (unsigned 16-bit getal) of tussen 0 en 4294967295 (unsigned 32-bit getal) door op te tellen met de helft van 65536 = 32768 of met de helft van 4294967296 = 2147483648.
      */
      let amplitude = sampleArray[channel][posSampleArray] + (bitsPerSample == 16 ? 32768 : 2147483648);
      rowData.push(amplitude);
    }
    imageData.push(rowData);
    rowData = [];
  }

  if(addToExistingImage){
    imageData = imageData.concat(originalImageData);
  }

  let image = new Jimp(width, height, function (err, image) {
    if (err) throw err;

    imageData.forEach((row, y) => {
      row.forEach((color, x) => {
        image.setPixelColor(color, x, y);
      });
    });

    const output = `encoded/${filenameWAV}_encoded.png`;

    image.write(output, (err) => {
      if (err) throw err;
    });

    console.log(`\n${stereo ? 'Stereo' : 'Mono'} audio converted to ${output}`);
  });
}

function createHeader(){
  let header = new Uint32Array(width);
  header[0] = numberOfEncodedLines;
  header[1] = numberOfChannels;
  header[2] = bitsPerSample;
  header[3] = sampleRate;
  header[4] = audioFormat;

  return header;
}

function printErr(){
  console.error('USAGE: node audio-to-image <REL-PATH-TO-AUDIO>.wav [<REL-PATH-TO-IMAGE>.png]');
  process.exit(1);
}
