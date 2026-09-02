import { getServerSession } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function HomePage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/start");
  redirect("/agents");
}
