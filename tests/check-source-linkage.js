'use strict';
// Development audit against explicitly supplied fresh MCP snapshots. No service calls or graph copying.
const fs=require('node:fs'),assert=require('node:assert/strict');
if(process.argv.length!==4)throw Error('Usage: node tests/check-source-linkage.js <fresh-main.json> <fresh-child.json>');
const read=p=>{const x=JSON.parse(fs.readFileSync(p));return x.workflow||x;};
const main=read(process.argv[2]),child=read(process.argv[3]);
const p=require('../deliverables/regression/lib/main-policy'),v=require('../deliverables/regression/lib/validate-order');
const link=require('../deliverables/regression/source-linkage.json'),defs=require('../deliverables/regression/model-definitions.json');
for(const item of link.expressions){const saved=(item.module==='main-policy'?main:child).nodes.find(n=>n.name===item.node);assert(saved,item.node);const fn=item.module==='main-policy'?p[item.function]:v[item.function];assert(saved.parameters.jsonOutput.includes(fn.toString()),item.node+': shared function body differs from current expression');}
const n=name=>main.nodes.find(n=>n.name===name).parameters;
if(main.versionId!==link.mainSourceVersion||child.versionId!==link.childSourceVersion)console.log('NOTE: workflow versions differ from captured provenance; selected source linkage is checked independently of layout/topology.');
assert.deepEqual(defs.extraction,{schemaType:n('ExtractRequestGroq').schemaType,inputSchema:n('ExtractRequestGroq').inputSchema,systemPromptTemplate:n('ExtractRequestGroq').options.systemPromptTemplate});
const canonical=t=>t.replace(/\$\('[^']+'\)\.item\.json\.(store_name|sign_off)/g,'MODEL_INPUT.$1');
assert.equal(canonical(defs.drafting.systemPromptTemplate),canonical(n('WriteVerifiedReplyGroq').messages.messageValues[0].message));
assert.deepEqual(defs.models.extraction,n('GroqExtractionModel'));assert.deepEqual(defs.models.drafting,n('GroqDraftingModel'));
require('../deliverables/regression/lib/check-source-linkage').checkSourceLinkage(link,defs,p,v);
console.log(`PASS source linkage: ${link.expressions.length} saved expressions and both model-stage prompt/schema/settings definitions match supplied current snapshots and included shared policy functions. No graph reconstruction.`);
