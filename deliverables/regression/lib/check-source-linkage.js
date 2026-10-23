'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
function checkSourceLinkage(link,definitions,policy,validator){
 for(const item of link.expressions){const fn=item.module==='main-policy'?policy[item.function]:validator[item.function];assert.equal(typeof fn,'function',item.function);assert(item.expression.includes(fn.toString()),`${item.node}: shared ${item.function} source differs from captured production expression`);}
 assert.equal(definitions.extraction.systemPromptTemplate,policy.extractionPrompt,'Extraction prompt differs from shared source');
 assert.deepEqual(JSON.parse(definitions.extraction.inputSchema),policy.schema,'Extraction schema differs from shared source');
 assert.equal(definitions.sourceMainVersion,link.modelSourceVersion || link.mainSourceVersion);
 assert.equal(crypto.createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),link.modelDefinitionsSha256,'Model prompt/schema/settings differ from the captured source definitions');
}
module.exports={checkSourceLinkage};
