import { z } from "zod";

const inputSchema = z.strictObject({
  op: z.literal("people"),
  keyword: z.string().trim().min(1).max(80),
  pageNo: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(20).default(10),
});
const pageSchema = z.object({
  records: z
    .array(
      z.object({
        username: z.string().trim().min(1),
        realname: z.string().nullish(),
        orgCodeTxt: z.string().nullish(),
        status: z.union([z.number(), z.string()]),
      }),
    )
    .max(20),
  total: z.number().int().nonnegative(),
});

export async function searchPeople(
  payload: unknown,
  read: (path: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
) {
  const input = inputSchema.safeParse(payload);
  if (!input.success) throw Error("PEOPLE_SEARCH_INVALID_REQUEST");
  signal.throwIfAborted();
  const { keyword, pageNo, pageSize } = input.data;
  const pages = await Promise.all(
    ["realname", "username"].map(async (field) => {
      const parameters = new URLSearchParams({
        [field]: keyword,
        pageNo: String(pageNo),
        pageSize: String(pageSize),
      });
      const response = await read("/sys/user/queryUserComponentData?" + parameters, signal);
      signal.throwIfAborted();
      const page = pageSchema.safeParse(response);
      if (!page.success) throw Error("PEOPLE_SEARCH_INVALID_RESPONSE");
      return page.data;
    }),
  );
  signal.throwIfAborted();
  const people = new Map<string, { username: string; realname: string; orgCodeTxt: string }>();
  for (const page of pages) {
    for (const person of page.records) {
      if (person.status !== 1 && person.status !== "1") continue;
      people.set(person.username, {
        username: person.username,
        realname: person.realname ?? "",
        orgCodeTxt: person.orgCodeTxt ?? "",
      });
    }
  }
  return {
    people: [...people.values()],
    hasMore: pages.some((page) => page.total > pageNo * pageSize),
  };
}
