const line = `import { OpenAIProvider } from './OpenAIProvider.js'`;
console.log('line:', JSON.stringify(line));
const oldName = 'OpenAIProvider';

// This is exactly what the rename script does
const regex1 = new RegExp(`((?:from|import|export)\\s+['"][^'"]*?)\\/${oldName}(\\.js)(['"])`, 'g');
console.log('regex1:', regex1);
const m1 = line.match(regex1);
console.log('match1:', m1);

// Try the replacement
const result = line.replace(regex1, `$1/openai-provider$2`);
console.log('result:', JSON.stringify(result));
console.log('original:', JSON.stringify(line));

// Now try without .js
const regex2 = new RegExp(`((?:from|import|export)\\s+['"][^'"]*?)\\/${oldName}(['"])`, 'g');
console.log('\nregex2:', regex2);
const m2 = line.match(regex2);
console.log('match2:', m2);
