const fs = require('fs');

const chars = ['、', '。', '，', '．'];
console.log(chars.map(c => c.charCodeAt(0).toString(16)));
