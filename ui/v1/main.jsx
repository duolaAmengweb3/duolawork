import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
if (new URLSearchParams(location.search).has("legacy")) import("../src.jsx");
else createRoot(document.getElementById("root")).render(<App />);
