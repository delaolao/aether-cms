import { setupHomeRoutes } from "./home.js"
import { setupContentRoutes } from "./content.js"
import { setupNotesRoutes } from "./notes.js"
import { setupTagCloudRoute } from "./tag-cloud.js"
import { setupVideoLibraryRoute } from "./videos.js"
import { setupSearchRoute } from "./search.js"
import { setupTaxonomyRoutes } from "./taxonomy.js"
import { setupCustomRoutes } from "./custom.js"
import { setupSeoRoutes } from "./seo.js"

export function setupFrontendRoutes(app, systems) {
    // Set up all frontend routes
    setupHomeRoutes(app, systems)
    setupContentRoutes(app, systems)
    setupNotesRoutes(app, systems)
    setupTagCloudRoute(app, systems)
    setupVideoLibraryRoute(app, systems)
    setupSearchRoute(app, systems)
    setupTaxonomyRoutes(app, systems)
    setupCustomRoutes(app, systems)
    setupSeoRoutes(app, systems)
}
