import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Home from "../pages/Home.jsx";

const mockNavigate = vi.fn();
const mockUseAuth = vi.fn();
let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn();

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/AuthContext.jsx", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("../components/SettingsMenu.jsx", () => ({
  default: () => <div data-testid="settings-menu" />,
}));

vi.mock("../components/ControlPanelView.jsx", () => ({
  default: () => <div data-testid="control-panel-view" />,
}));

const baseAuth = {
  logout: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  authBusy: false,
  resendVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  changePassword: vi.fn(),
};

const createSignedOutAuth = () => ({
  ...baseAuth,
  user: null,
  token: null,
});

const createSignedInAuth = () => ({
  ...baseAuth,
  user: {
    email: "coach@example.com",
    displayName: "Coach",
  },
  token: "test-token",
});

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const renderHome = () => render(<Home />);

describe("Home tournaments tab", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockUseAuth.mockReset();
    mockSearchParams = new URLSearchParams();
    mockSetSearchParams.mockReset();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders service landing and activates the Tournaments module", async () => {
    mockUseAuth.mockReturnValue(createSignedOutAuth());
    const user = userEvent.setup();

    renderHome();

    expect(screen.getByRole("button", { name: /Scoreboard Overlays/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tournaments/i }));
    expect(screen.getByRole("heading", { name: "Tournament Hub" })).toBeInTheDocument();
  });

  it("shows sign-in call to action for signed-out users", async () => {
    mockUseAuth.mockReturnValue(createSignedOutAuth());
    const user = userEvent.setup();

    renderHome();
    await user.click(screen.getByRole("button", { name: /Tournaments/i }));

    expect(
      screen.getByRole("link", { name: "Sign in to manage tournaments" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create tournament" })).not.toBeInTheDocument();
  });

  it("creates a tournament and navigates to Pool Play 1", async () => {
    mockUseAuth.mockReturnValue(createSignedInAuth());
    const user = userEvent.setup();

    const createdTournament = {
      _id: "tour-1",
      name: "City Finals",
      date: "2026-06-01T00:00:00.000Z",
      timezone: "America/New_York",
      publicCode: "AB12CD",
      status: "setup",
    };

    let tournamentListCalls = 0;
    globalThis.fetch.mockImplementation(async (url, options = {}) => {
      const requestUrl = String(url);
      const method = options.method || "GET";

      if (requestUrl.endsWith("/api/scoreboards/mine")) {
        return jsonResponse([]);
      }

      if (requestUrl.endsWith("/api/tournaments") && method === "GET") {
        tournamentListCalls += 1;
        return jsonResponse(tournamentListCalls > 1 ? [createdTournament] : []);
      }

      if (requestUrl.endsWith("/api/tournaments") && method === "POST") {
        return jsonResponse(createdTournament, 201);
      }

      if (requestUrl.endsWith("/api/tournaments/tour-1")) {
        return jsonResponse(createdTournament);
      }

      if (requestUrl.endsWith("/api/tournaments/tour-1/teams")) {
        return jsonResponse([]);
      }

      return jsonResponse([]);
    });

    renderHome();
    await user.click(screen.getByRole("button", { name: /Tournaments/i }));

    await user.type(screen.getByLabelText("Tournament name"), "City Finals");
    fireEvent.change(screen.getByLabelText("Tournament date"), {
      target: { value: "06-01-2026" },
    });

    await user.click(screen.getByRole("button", { name: "Create tournament" }));

    await waitFor(() => {
      expect(
        globalThis.fetch.mock.calls.some(
          ([url, options]) =>
            String(url).includes("/api/tournaments") && options?.method === "POST"
        )
      ).toBe(true);
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/tournaments/tour-1/phase1");
    });
  });

  it("shows details and team setup links in Tournament Hub rows", async () => {
    mockUseAuth.mockReturnValue(createSignedInAuth());
    const user = userEvent.setup();

    const tournamentSummary = {
      _id: "tour-locked",
      name: "Spring Open",
      date: "2026-04-20T00:00:00.000Z",
      timezone: "America/New_York",
      publicCode: "LOCKED",
      status: "phase1",
    };

    globalThis.fetch.mockImplementation(async (url) => {
      const requestUrl = String(url);

      if (requestUrl.endsWith("/api/scoreboards/mine")) {
        return jsonResponse([]);
      }

      if (requestUrl.endsWith("/api/tournaments")) {
        return jsonResponse([tournamentSummary]);
      }

      return jsonResponse([]);
    });

    renderHome();
    await user.click(screen.getByRole("button", { name: /Tournaments/i }));

    expect(await screen.findByText("Your Tournaments")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tournament Details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Team Setup" })).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Details" })).toHaveAttribute(
      "href",
      "/tournaments/tour-locked/details"
    );
    expect(screen.getByRole("link", { name: "Team Setup" })).toHaveAttribute(
      "href",
      "/tournaments/tour-locked/teams"
    );
  });
});
