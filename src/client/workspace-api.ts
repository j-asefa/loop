// Fleet-only callers retain this entry point until their separate removal.
// Other client modules import the owning transport module directly.
export {
  callRoute,
  readRoute,
  routePath,
  routeUrl,
  fetchStream,
  UnavailableResponse,
} from "./api";
