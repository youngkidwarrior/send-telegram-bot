import { z } from 'zod';

export const ProfileSchema = z.object({
  id: z.null(),
  avatar_url: z.string().url(),
  name: z.string(),
  about: z.string(),
  refcode: z.string(),
  x_username: z.string(),
  tag: z.string(),
  address: z.string(),
  chain_id: z.number(),
  is_public: z.boolean(),
  sendid: z.number(),
  all_tags: z.array(z.string())
});

export const ErrorSchema = z.object({
  code: z.string(),
  details: z.null(),
  hint: z.null(),
  message: z.string()
});

export const ProfileResponseSchema = z.array(ProfileSchema);

export type Profile = z.infer<typeof ProfileSchema>;
export type APIError = z.infer<typeof ErrorSchema>;