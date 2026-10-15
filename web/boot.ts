import "./web.css";
import { mountBadge } from "./shim/badge";

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountBadge);
else mountBadge();
