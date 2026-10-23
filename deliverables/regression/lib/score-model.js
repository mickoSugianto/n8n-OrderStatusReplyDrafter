'use strict';
// Model-stage constraints only: no order lookup, business routing or save policy.
function scoreModel(c,response,source){
 const error=response.error?(typeof response.error==='string'?response.error:response.error.message||JSON.stringify(response.error)):'';
 const output=c.stage==='extraction'?response.output:response.text;
 let metrics;
 if(c.stage==='extraction'){
  const schema=!!output&&typeof output==='object'&&!Array.isArray(output)&&Object.keys(output).length===3&&['request_type','order_numbers','reason'].every(k=>Object.hasOwn(output,k))&&['order_update','manual_review'].includes(output.request_type)&&Array.isArray(output.order_numbers)&&output.order_numbers.every(n=>typeof n==='string'&&/^\d+$/.test(n))&&typeof output.reason==='string';
  metrics={schema:Number(schema),requestType:Number(output?.request_type===c.expected.requestType),orderNumbers:Number(schema&&JSON.stringify([...new Set(output.order_numbers)].sort())===JSON.stringify([...c.expected.orderNumbers].sort()))};
 }else{
  const text=typeof output==='string'?output.trim():'';const order=c.input.order;
  const dates=text.match(/\b\d{4}-\d{2}-\d{2}\b/g)||[];
  metrics={nonempty:Number(!!text),status:Number(new RegExp(c.expected.statusPattern,'i').test(text)),tracking:Number(!order.tracking_number||text.includes(order.tracking_number)),estimate:Number(!order.estimated_delivery||text.includes(order.estimated_delivery)&&/estimat/i.test(text)),noUnexpectedIsoDate:Number(dates.every(d=>d===order.estimated_delivery)),timing:Number(!c.expected.timingPattern||new RegExp(c.expected.timingPattern,'i').test(text)),deliveredTiming:Number(order.status!=='delivered'||!/estimat|unknown.*(?:dispatch|delivery)|(?:dispatch|delivery).*unknown/i.test(text)),noUrl:Number(!/http|www\./i.test(text))};
 }
 return {caseId:c.caseId,stage:c.stage,provider:'groq',model:source.model,source,actual:output??null,metrics,error,pass:!error&&Object.values(metrics).every(x=>x===1)};
}
module.exports={scoreModel};
