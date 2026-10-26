// Keep transport private: contract and legacy entry points share the same IO.
export {
  callRoute,
  readRoute,
  routePath,
  routeUrl,
  fetchStream,
  UnavailableResponse,
} from "./api";
