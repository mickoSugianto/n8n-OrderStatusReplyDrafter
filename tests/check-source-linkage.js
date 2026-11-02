'use strict';
// Development audit against supplied or default workflow snapshots. No service calls or graph copying.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');

function checkSourceLinkage(link,definitions,policy,validator){
 for(const item of link.expressions){const fn=item.module==='main-policy'?policy[item.function]:validator[item.function];assert.equal(typeof fn,'function',item.function);assert(item.expression.includes(fn.toString()),`${item.node}: shared ${item.function} source differs from captured production expression`);}
 assert.equal(definitions.extraction.systemPromptTemplate,policy.extractionPrompt,'Extraction prompt differs from shared source');
 assert.deepEqual(JSON.parse(definitions.extraction.inputSchema),policy.schema,'Extraction schema differs from shared source');
 assert.equal(definitions.sourceMainVersion,link.modelSourceVersion || link.mainSourceVersion);
 assert.equal(crypto.createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),link.modelDefinitionsSha256,'Model prompt/schema/settings differ from the captured source definitions');
}

if(require.main===module){
 const root=path.resolve(__dirname,'..');
 const mainPath=process.argv[2]||path.join(root,'workflows/main-workflow.json');
 const childPath=process.argv[3]||path.join(root,'workflows/get-order.json');
 const read=p=>{const x=JSON.parse(fs.readFileSync(p));return x.workflow||x;};
 const main=read(mainPath),child=read(childPath);
 const p=require('../src/main-policy'),v=require('../src/validate-order');
 const link=require('../src/source-linkage.json'),defs=require('../src/model-definitions.json');
 for(const item of link.expressions){const saved=(item.module==='main-policy'?main:child).nodes.find(n=>n.name===item.node);assert(saved,item.node);const fn=item.module==='main-policy'?p[item.function]:v[item.function];assert(saved.parameters.jsonOutput.includes(fn.toString()),item.node+': shared function body differs from current expression');}
 const n=name=>main.nodes.find(n=>n.name===name).parameters;
 if(main.versionId!==link.mainSourceVersion||child.versionId!==link.childSourceVersion)console.log('NOTE: workflow versions differ from captured provenance; selected source linkage is checked independently of layout/topology.');
 assert.deepEqual(defs.extraction,{schemaType:n('ExtractRequestGroq').schemaType,inputSchema:n('ExtractRequestGroq').inputSchema,systemPromptTemplate:n('ExtractRequestGroq').options.systemPromptTemplate});
 const canonical=t=>t.replace(/\$\('[^']+'\)\.item\.json\.(store_name|sign_off)/g,'MODEL_INPUT.$1');
 assert.equal(canonical(defs.drafting.systemPromptTemplate),canonical(n('WriteVerifiedReplyGroq').messages.messageValues[0].message));
 assert.deepEqual(defs.models.extraction,n('GroqExtractionModel'));assert.deepEqual(defs.models.drafting,n('GroqDraftingModel'));
 checkSourceLinkage(link,defs,p,v);
 console.log(`PASS source linkage: ${link.expressions.length} saved expressions and both model-stage prompt/schema/settings definitions match supplied current snapshots and included shared policy functions. No graph reconstruction.`);
}

module.exports={checkSourceLinkage};
