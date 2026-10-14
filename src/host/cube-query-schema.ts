import type { ParameterSchemaSpec, ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import { CUBE_FILTER_OPERATORS } from "./cube-operators.ts";
const strings = { type: "array", items: { type: "string" } } as const;
const leaf: ValueSchemaSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    member: { type: "string", required: true },
    operator: { type: "string", required: true, enum: [...CUBE_FILTER_OPERATORS] },
    values: strings,
  },
};
const filter = (depth: number): ValueSchemaSpec =>
  depth === 0
    ? leaf
    : {
        oneOf: [
          leaf,
          {
            type: "object",
            additionalProperties: false,
            properties: { and: { type: "array", required: true, items: filter(depth - 1) } },
          },
          {
            type: "object",
            additionalProperties: false,
            properties: { or: { type: "array", required: true, items: filter(depth - 1) } },
          },
        ],
      };
export const cubeQueryParameters = {
  consumerCode: {
    type: "string",
    description:
      "省略时由宿主使用所选业务Agent身份。只有明确的跨业务任务才指定已注册编码；授权拒绝后不得换身份试探。",
  },
  queries: {
    type: "array",
    required: true,
    description: "1–8 条独立具名查询；每条只引用一个模型。宿主按模型分开执行。",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", required: true },
        query: {
          type: "object",
          required: true,
          additionalProperties: false,
          properties: {
            dimensions: strings,
            measures: strings,
            segments: strings,
            filters: { type: "array", items: filter(2) },
            order: {
              type: "array",
              description: "排序顺序。member 是目录完整成员名，direction 为 asc 或 desc。",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  member: { type: "string", required: true },
                  direction: { type: "string", required: true, enum: ["asc", "desc"] },
                },
              },
            },
            timeDimensions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  dimension: { type: "string", required: true },
                  granularity: { type: "string" },
                  dateRange: strings,
                },
              },
            },
            limit: {
              type: "integer",
              description: "默认 50，最多 200，同时受当前资源 maxRows 限制。",
            },
            offset: { type: "integer" },
            timezone: { type: "string" },
            total: {
              type: "boolean",
              description:
                "Cube-New 如提交只能为 true；false 仅适用于声明支持的旧来源。以当前 MCP 工具 schema 为准。",
            },
            ungrouped: {
              type: "boolean",
              description: "仅适用于声明支持的旧 Cube 来源；Cube-New 不接受此字段。",
            },
          },
        },
      },
    },
  },
  response_mode: {
    type: "string",
    enum: ["inline_complete"],
    description: "宿主在同一业务会话中读取网关返回的制品，结果完整性另行核验。",
  },
} as const satisfies ParameterSchemaSpec;
