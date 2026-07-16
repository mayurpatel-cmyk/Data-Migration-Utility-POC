import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ollama from 'ollama';

const DEFAULT_SOURCE_FIELDS = ['cust_id', 'fname', 'lname', 'tx_dt', 'amt_usd'];
const DEFAULT_TARGET_FIELDS = ['customer_id', 'first_name', 'last_name', 'transaction_date', 'amount'];

function printUsage() {
  console.log('Usage: node mapping-agent.js [options]');
  console.log('Options:');
  console.log('  --source "field1,field2"   Comma-separated source field names');
  console.log('  --target "field1,field2"   Comma-separated target field names');
  console.log('  --source-file path         JSON array or newline-delimited list for source');
  console.log('  --target-file path         JSON array or newline-delimited list for target');
  console.log('  --model name               Ollama model name (default: llama3.1)');
  console.log('  --json                     Print the mapping as JSON for programmatic use');
  console.log('  --fast                     Skip the slower model call and use fast heuristic matching');
  console.log('  --help                     Show this help message');
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadFieldList(filePath) {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const content = fs.readFileSync(absolutePath, 'utf8').trim();
  if (!content) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(content);
    if (Array.isArray(parsedValue)) {
      return parsedValue;
    }
  } catch {
    // Fall back to newline-delimited parsing below.
  }

  return content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCliArguments(argv) {
  const options = {
    sourceFields: DEFAULT_SOURCE_FIELDS,
    targetFields: DEFAULT_TARGET_FIELDS,
    model: process.env.OLLAMA_MODEL || 'llama3.1',
    jsonOutput: false,
    fastMode: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case '--source':
      case '-s':
        options.sourceFields = parseList(argv[index + 1]);
        index += 1;
        break;
      case '--target':
      case '-t':
        options.targetFields = parseList(argv[index + 1]);
        index += 1;
        break;
      case '--source-file':
        options.sourceFields = loadFieldList(argv[index + 1]);
        index += 1;
        break;
      case '--target-file':
        options.targetFields = loadFieldList(argv[index + 1]);
        index += 1;
        break;
      case '--model':
        options.model = argv[index + 1];
        index += 1;
        break;
      case '--json':
        options.jsonOutput = true;
        break;
      case '--fast':
        options.fastMode = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unsupported argument: ${argument}`);
    }
  }

  return options;
}

function normalizeFieldName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildHeuristicMapping(sourceFields, targetFields) {
  const mapping = {};
  const usedTargets = new Set();

  sourceFields.forEach((sourceField) => {
    const sourceNorm = normalizeFieldName(sourceField);
    let bestMatch = null;
    let bestScore = -Infinity;

    targetFields.forEach((targetField, targetIndex) => {
      if (usedTargets.has(targetIndex)) {
        return;
      }

      const targetNorm = normalizeFieldName(targetField);
      const sourceTokens = new Set(sourceNorm.split(' ').filter(Boolean));
      const targetTokens = new Set(targetNorm.split(' ').filter(Boolean));
      const overlap = [...sourceTokens].filter((token) => targetTokens.has(token)).length * 2;

      let score = overlap;
      if (sourceNorm.includes('cust') && targetNorm.includes('customer')) score += 3;
      if ((sourceNorm.includes('fname') || sourceNorm.includes('first')) && (targetNorm.includes('first') || targetNorm.includes('name'))) score += 3;
      if ((sourceNorm.includes('lname') || sourceNorm.includes('last')) && (targetNorm.includes('last') || targetNorm.includes('name'))) score += 3;
      if ((sourceNorm.includes('tx') || sourceNorm.includes('transaction')) && targetNorm.includes('transaction')) score += 3;
      if ((sourceNorm.includes('dt') || sourceNorm.includes('date')) && targetNorm.includes('date')) score += 3;
      if ((sourceNorm.includes('amt') || sourceNorm.includes('amount')) && targetNorm.includes('amount')) score += 3;
      if (sourceNorm === targetNorm) score += 5;
      if (sourceNorm.includes(targetNorm) || targetNorm.includes(sourceNorm)) score += 2;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { field: targetField, index: targetIndex };
      }
    });

    if (bestMatch) {
      mapping[sourceField] = bestMatch.field;
      usedTargets.add(bestMatch.index);
    } else {
      mapping[sourceField] = targetFields[0];
    }
  });

  return mapping;
}

// Helper: colorize and display mapping for review
function colorize(value, origin) {
  const RESET = '\x1b[0m';
  const BLUE = '\x1b[34m';
  const GREEN = '\x1b[32m';
  if (origin === 'agent') return `${BLUE}${value}${RESET}`;
  if (origin === 'heuristic') return `${GREEN}${value}${RESET}`;
  return value;
}

function displayMapping(mapping, origins, jsonOutput) {
  if (jsonOutput) {
    // When JSON output is requested, include origins so the caller can programmatically inspect which entries came from the agent vs heuristic
    console.log(JSON.stringify({ mapping, origins }, null, 2));
    return;
  }

  console.log('\n🎯 Schema Mapping Output (blue = agent, green = heuristic):');
  const tableRows = Object.keys(mapping).map((src) => ({
    'Source Field': src,
    'Mapped To': colorize(mapping[src], origins && origins[src])
  }));
  console.table(tableRows);
}

function parseLlmMapping(rawValue) {
  if (!rawValue) {
    throw new Error('Ollama returned an empty response.');
  }

  let parsedValue = rawValue;
  if (typeof rawValue === 'string') {
    const trimmedValue = rawValue.trim();
    const firstBrace = trimmedValue.indexOf('{');
    const lastBrace = trimmedValue.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      parsedValue = trimmedValue.slice(firstBrace, lastBrace + 1);
    }

    parsedValue = JSON.parse(parsedValue);
  }

  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('Ollama response was not a JSON object.');
  }

  return parsedValue;
}

async function runMappingAgent(options = {}) {
  console.log('🧠 Processing schema fields...');

  const resolvedOptions = {
    ...parseCliArguments(process.argv),
    ...options
  };

  const sourceFields = Array.isArray(resolvedOptions.sourceFields) && resolvedOptions.sourceFields.length > 0
    ? resolvedOptions.sourceFields
    : DEFAULT_SOURCE_FIELDS;
  const targetFields = Array.isArray(resolvedOptions.targetFields) && resolvedOptions.targetFields.length > 0
    ? resolvedOptions.targetFields
    : DEFAULT_TARGET_FIELDS;

  const shouldUseFastHeuristic = resolvedOptions.fastMode;

  if (shouldUseFastHeuristic) {
    const finalMapping = buildHeuristicMapping(sourceFields, targetFields);
    const origins = {};
    sourceFields.forEach((src) => { origins[src] = 'heuristic'; });
    displayMapping(finalMapping, origins, resolvedOptions.jsonOutput);
    return finalMapping;
  }

  const systemInstructions = `
    You are a schema mapping helper.
    Return only a raw JSON object.
    Keys must be source field names.
    Values must be the best matching target field names from the target schema list.
    Do not use markdown or extra explanation.
  `;

  const userPrompt = `
    Source Fields: ${JSON.stringify(sourceFields)}
    Target Schema: ${JSON.stringify(targetFields)}
  `;

  try {
    const response = await Promise.race([
      ollama.chat({
        model: resolvedOptions.model,
        messages: [
          { role: 'system', content: systemInstructions },
          { role: 'user', content: userPrompt }
        ],
        format: 'json',
        stream: false,
        options: {
          temperature: 0.0,
          num_predict: 128,
          top_p: 0.9,
          repeat_penalty: 1.1
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Ollama timeout')), 6000))
    ]);

    const llmMapping = parseLlmMapping(response.message.content);
    const heuristicMapping = buildHeuristicMapping(sourceFields, targetFields);
    const mergedMapping = {};
    const origins = {};
    sourceFields.forEach((src) => {
      if (Object.prototype.hasOwnProperty.call(llmMapping, src) && llmMapping[src]) {
        mergedMapping[src] = llmMapping[src];
        origins[src] = 'agent';
      } else {
        mergedMapping[src] = heuristicMapping[src];
        origins[src] = 'heuristic';
      }
    });

    displayMapping(mergedMapping, origins, resolvedOptions.jsonOutput);
    return mergedMapping;
  } catch (error) {
    console.warn('⚠️  Ollama returned an invalid response or is unavailable. Falling back to a heuristic mapping.');
    const finalMapping = buildHeuristicMapping(sourceFields, targetFields);
    const origins = {};
    sourceFields.forEach((src) => { origins[src] = 'heuristic'; });
    displayMapping(finalMapping, origins, resolvedOptions.jsonOutput);
    return finalMapping;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const invokedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFilePath && invokedFilePath === currentFilePath) {
  runMappingAgent();
}

export { buildHeuristicMapping, parseCliArguments, runMappingAgent };
