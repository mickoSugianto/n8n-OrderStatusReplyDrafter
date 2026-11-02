'use strict';
// CSV reconstruction only. No network or n8n writes.
const d=require('./evaluation-cases.json');
const columns=['caseId','stage','provider','model','source_object','case_object','expected_object','actual_object','metrics_object','pass','error','run_object'];
const rows=d.cases.map(c=>[c.caseId,c.stage,'groq',d.provenance[c.stage].model,JSON.stringify(d.provenance[c.stage]),JSON.stringify(c),JSON.stringify(c.expected),'','','','','']);
const csv=x=>'"'+String(x??'').replaceAll('"','""')+'"';
process.stdout.write([columns,...rows].map(row=>row.map(csv).join(',')).join('\n')+'\n');
