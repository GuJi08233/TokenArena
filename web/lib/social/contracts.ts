import { z } from "zod";
import { followTagFilterValues, followTags } from "./follow-tags";

const followTagSchema = z.enum(followTags);

export const followTagUpdateSchema = z.object({
  tag: followTagSchema.nullable(),
});

export const followTagFilterSchema = z.enum(followTagFilterValues);
