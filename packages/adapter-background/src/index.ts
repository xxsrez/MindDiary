import { BACKGROUND_HANDLERS } from "@mind-diary/application-background";

export const BACKGROUND_APPLICATION_BOUNDARY = {
  handlers: BACKGROUND_HANDLERS,
  authorityFromJobPayload: false,
} as const;
