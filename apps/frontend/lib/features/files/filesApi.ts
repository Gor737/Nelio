import { nelioApiSlice } from "@/lib/api/nelioApiSlice";
import { FileAsset } from "@/lib/types/fileTypes";

export const filesApi = nelioApiSlice.injectEndpoints({
  endpoints: (build) => ({
    // POST /files (multipart). Pass a FormData with `kind` and `file`.
    // No Content-Type header on purpose: the browser sets multipart/form-data with the boundary itself.
    uploadFile: build.mutation<FileAsset, FormData>({
      query: (formData) => ({
        url: "/files",
        method: "POST",
        body: formData,
      }),
    }),
  }),
});

export const { useUploadFileMutation } = filesApi;
