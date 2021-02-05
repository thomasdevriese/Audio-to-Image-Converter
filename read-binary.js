/*
  Structuur van wav bestand testen
*/

const fs = require('fs');
const path = require('path');

const filepath = process.argv[2];
if(!filepath){
  printErr();
}
const regex = /^(?:[\w-() ]+\/)*([\w-() ]+)\.wav$/i;
const matches = filepath.match(regex);
if(!matches){
  printErr();
}

// wav bestand inlezen
const file = fs.readFileSync(path.join(__dirname, `./${filepath}`));

// inhoud bekijken

console.log(file.slice(0,4)); //RIFF
console.log(file.slice(4,8)); //ChunkSize
console.log(file.slice(8,12)); //WAVE

console.log(file.slice(12,16)); //fmt 
console.log(file.slice(16,20)); //Subchunk1Size
console.log(file.slice(20,22)); //AudioFormat
console.log(file.slice(22,24)); //NumChannels
console.log(file.slice(24,28)); //SampleRate
console.log(file.slice(28,32)); //ByteRate
console.log(file.slice(32,34)); //BlockAlign
console.log(file.slice(34,36)); //BitsPerSample

console.log(file.slice(36,40)); //Subchunk2ID
console.log(file.slice(40,44)); //Subchunk2Size

// effectieve data vanaf 44
console.log(file.slice(44,60)); //data

function printErr(){
  console.error('USAGE: node read-binary <REL-PATH-TO-AUDIO>.wav');
  process.exit(1);
}
