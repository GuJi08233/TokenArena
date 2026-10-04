import { notFound } from "next/navigation";

// Unknown paths inside a locale render the localized not-found page instead
// of the root one, which has no access to the locale layout.
export default function UnknownLocaleRoute() {
  notFound();
}
