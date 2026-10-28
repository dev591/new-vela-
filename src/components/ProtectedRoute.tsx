import React, { useEffect } from "react"
import { Navigate } from "react-router-dom"
import { isAuthenticated } from "../utils/auth"
import { connectSocket } from "../hooks/useSocket"

const ROLE_HOME: Record<string, string> = {
  doctor: "/dashboard",
  receptionist: "/receptionist",
  patient: "/patient-dashboard",
  hospital_manager: "/hospital-manager",
  manager: "/hospital-manager",
  lab_controller: "/lab-controller",
  lab: "/lab-controller",
  vela_owner: "/vela-owner",
}

export default function ProtectedRoute({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const authed = isAuthenticated()
  // Every signed-in page goes through here, so this is where the live socket
  // gets connected with the session token.
  useEffect(() => { if (authed) connectSocket() }, [authed])
  if (!authed) return <Navigate to="/login" replace />
  if (roles && roles.length > 0) {
    const role = localStorage.getItem("vela_role") || ""
    if (!roles.includes(role)) {
      // Logged in but wrong portal — send them to their own home instead
      return <Navigate to={ROLE_HOME[role] || "/login"} replace />
    }
  }
  return <>{children}</>
}
