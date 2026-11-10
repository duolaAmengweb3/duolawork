import React from "react";
import { createRoot } from "react-dom/client";
import App from "../conversation/App.jsx";
const Classic = React.lazy(()=>import("./App.jsx"));
import "./styles.css";
if (new URLSearchParams(location.search).has("legacy")) import("../src.jsx");
else if(new URLSearchParams(location.search).has("classic")) createRoot(document.getElementById("root")).render(<React.Suspense fallback="正在打开历史工作区…"><Classic /></React.Suspense>);
else createRoot(document.getElementById("root")).render(<App />);
