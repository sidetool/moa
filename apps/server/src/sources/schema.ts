import { object } from '../http.js';

const filterChange = object({ position: { type: 'integer', minimum: 0, maximum: 511 }, groupPosition: { type: 'integer', minimum: 0, maximum: 511 }, value: { type:['string','number','boolean','object'], maxLength:2000, additionalProperties:false, properties:{index:{type:'integer',minimum:0},ascending:{type:'boolean'}}, required:['index','ascending'] } }, ['position','value']);
export const browseSelection = object({ revision: {type:'string',maxLength:80}, filters: {type:'array',maxItems:512,items:filterChange} }, ['revision','filters']);
