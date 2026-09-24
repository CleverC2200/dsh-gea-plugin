import type {ParameterSchemaSpec, ValueSchemaSpec} from '@deepseek-ai/dsh-tools';
const strings = {type:'array',items:{type:'string'}} as const;
const leaf: ValueSchemaSpec = {type:'object',additionalProperties:false,properties:{member:{type:'string',required:true},operator:{type:'string',required:true},values:strings}};
const filter = (depth: number): ValueSchemaSpec => depth === 0 ? leaf : {oneOf:[leaf,
  {type:'object',additionalProperties:false,properties:{and:{type:'array',required:true,items:filter(depth-1)}}},
  {type:'object',additionalProperties:false,properties:{or:{type:'array',required:true,items:filter(depth-1)}}}]};
export const cubeQueryParameters = {
  consumerCode:{type:'string',required:true,description:'已注册业务 Agent 编码，使用系统协议或业务模块清单里的原始编码，不能按业务名称自行翻译。使用所选业务身份，拒绝后不换身份重试。'},
  queries:{type:'array',required:true,description:'1–8 条独立具名查询；每条只引用一个模型。宿主按模型分开执行。',items:{type:'object',additionalProperties:false,properties:{
    name:{type:'string',required:true},
    query:{type:'object',required:true,additionalProperties:false,properties:{
      dimensions:strings,measures:strings,segments:strings,
      filters:{type:'array',items:filter(2)},
      order:{type:'array',description:'排序顺序。member 是目录完整成员名，direction 为 asc 或 desc。',items:{type:'object',additionalProperties:false,properties:{member:{type:'string',required:true},direction:{type:'string',required:true,enum:['asc','desc']}}}},
      timeDimensions:{type:'array',items:{type:'object',additionalProperties:false,properties:{dimension:{type:'string',required:true},granularity:{type:'string'},dateRange:strings}}},
      limit:{type:'integer',description:'默认 50，最多 200，同时受当前资源 maxRows 限制。'},offset:{type:'integer'},timezone:{type:'string'},total:{type:'boolean'},ungrouped:{type:'boolean'},
    }},
  }}},
  response_mode:{type:'string',enum:['resource','inline_complete']},
} as const satisfies ParameterSchemaSpec;
