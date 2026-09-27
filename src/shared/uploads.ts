export type UploadedFile = {
  id: string;
  objectId: string;
  name: string;
  mime: string;
  size: number;
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_FILES = 8;
