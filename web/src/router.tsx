import { createBrowserRouter } from "react-router-dom";
import ChatView from "./views/ChatView";
import AdminView from "./views/AdminView";

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
