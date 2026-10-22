// Prefix a site-internal path with the configured `base` (e.g. "/yeshasvi"), so the site
// works both at a domain root and under a GitHub Pages project path.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export const url = (path = '/') => BASE + (path.startsWith('/') ? path : `/${path}`);
