import { ShipwrightApi } from "./store/api";
import { Spinner } from "./components/ui/spinner";
import { RouterProvider } from "@tanstack/react-router";
import { createRouter } from "./router";
import { Suspense } from "react";
import { RegistryProvider, useAtomMount } from "@effect/atom-react";

const router = createRouter();

function AppRuntime({ children }: { children: React.ReactNode }) {
  useAtomMount(ShipwrightApi.runtime);
  return <>{children}</>;
}

export function Main() {
  return (
    <RegistryProvider>
      <AppRuntime>
        <Suspense fallback={<Spinner />}>
          <RouterProvider router={router} />
        </Suspense>
      </AppRuntime>
    </RegistryProvider>
  );
}
