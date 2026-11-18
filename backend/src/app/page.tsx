import { redirect } from "next/navigation";

// The backend has no public page: its root opens the admin portal (which asks for sign-in).
export default function Home() {
  redirect("/admin");
}
