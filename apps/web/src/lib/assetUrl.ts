import { authState } from "@/lib/auth";

export default function assetUrl(directory: string | undefined, path: string, thumbnail = false) {
  const params = new URLSearchParams({ path });
  if (directory) params.set("directory", directory);
  if (thumbnail) params.set("thumbnail", "true");
  const user = authState.value.user;
  if (user) params.set("userId", user.id);
  return `/api/assets/read?${params}`;
}
