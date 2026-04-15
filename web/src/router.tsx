import { createBrowserRouter } from "react-router-dom";
import AdminView from "./views/AdminView";
import ChatView from "./views/ChatView";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <ChatView />,
  },
  {
    path: "/admin",
    element: <AdminView />,
  },
]);
