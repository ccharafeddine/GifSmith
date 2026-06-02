/* @refresh reload */
import { render } from "solid-js/web";
import "./tokens.css";
import "./fonts.css";
import App from "./App";

render(() => <App />, document.getElementById("root") as HTMLElement);
