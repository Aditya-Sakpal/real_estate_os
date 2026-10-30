import { notFound } from "next/navigation";

/**
 * A section that does not exist, answered inside the console's shell.
 *
 * This route used to render a "not built yet" page for Site visits, Partners
 * and Reports. All three have screens of their own now, and a route of the
 * same name beats this one, so what still lands here is an address nobody
 * built: a typo, or an old link. Keeping the route means that answer arrives
 * with the rail and the bar around it, rather than as a bare page with no way
 * back.
 */
export default function UnknownSection() {
  notFound();
}
