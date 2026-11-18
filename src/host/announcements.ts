import { z } from "zod";

const route = "/api/v1/announcements";
const id = z
  .string()
  .max(64)
  .refine((value) => value.trim() !== "" && value !== "." && value !== "..");
const pageNo = z.number().int().min(1).max(2147483647);
const pageSize = z.number().int().min(1).max(100);
const input = z.union([
  z.strictObject({ id }),
  z.strictObject({
    pageNo: pageNo.default(1),
    pageSize: pageSize.default(20),
    title: z.string().trim().max(100).optional(),
  }),
]);
const nullableText = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const summary = z.object({
  id,
  title: nullableText,
  summary: nullableText,
  publishTime: nullableText,
  priority: nullableText,
  top: z.boolean(),
});
const page = z.object({
  items: z.array(summary),
  total: z.number().int().nonnegative(),
  pageNo,
  pageSize,
});
const detail = summary.extend({
  content: nullableText,
  startTime: nullableText,
  endTime: nullableText,
});

export async function readAnnouncements(
  payload: unknown,
  read: (path: string) => Promise<unknown>,
) {
  const parsed = input.safeParse(payload);
  if (!parsed.success) throw Error("ANNOUNCEMENT_REQUEST_INVALID");
  const query = parsed.data;
  if ("id" in query) {
    const response = detail.safeParse(await read(route + "/" + encodeURIComponent(query.id)));
    if (!response.success || response.data.id !== query.id)
      throw Error("ANNOUNCEMENT_INVALID_RESPONSE");
    return { detail: response.data };
  }
  const params = new URLSearchParams({
    pageNo: String(query.pageNo),
    pageSize: String(query.pageSize),
  });
  if (query.title) params.set("title", query.title);
  const response = page.safeParse(await read(route + "?" + params));
  if (
    !response.success ||
    response.data.pageNo !== query.pageNo ||
    response.data.pageSize !== query.pageSize ||
    response.data.items.length > Math.min(query.pageSize, response.data.total)
  )
    throw Error("ANNOUNCEMENT_INVALID_RESPONSE");
  return response.data;
}
