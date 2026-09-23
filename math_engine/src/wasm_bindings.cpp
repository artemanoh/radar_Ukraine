#include <emscripten/bind.h>
#include "trajectory.hpp"
#include <string>
#include <sstream>

using namespace emscripten;

// Helper to convert std::vector<GeoPoint> to JSON string
std::string computeConeJSON(double lat, double lon, double vx, double vy, double forecast_s, int steps) {
    TrajectoryEngine engine;
    Target t;
    t.id = "target_wasm";
    t.position = {lat, lon};
    t.velocity = {vx, vy};
    t.altitude_m = 1000.0;
    t.timestamp_s = 0.0;

    ThreatZone tz = engine.computeThreatZone(t, forecast_s, steps);
    
    std::ostringstream oss;
    oss << "{\"target_id\":\"" << tz.target_id << "\",\"eta\":" << tz.eta_seconds << ",\"certainty\":" << tz.certainty_probability << ",\"polygon\":[";
    for(size_t i = 0; i < tz.cone_polygon.size(); ++i) {
        oss << "[" << tz.cone_polygon[i].lat << "," << tz.cone_polygon[i].lon << "]";
        if(i < tz.cone_polygon.size() - 1) oss << ",";
    }
    oss << "]}";
    
    return oss.str();
}

EMSCRIPTEN_BINDINGS(airradar) {
    value_object<GeoPoint>("GeoPoint")
        .field("lat", &GeoPoint::lat)
        .field("lon", &GeoPoint::lon);

    value_object<Velocity>("Velocity")
        .field("vx_ms", &Velocity::vx_ms)
        .field("vy_ms", &Velocity::vy_ms);

    value_object<Target>("Target")
        .field("id", &Target::id)
        .field("position", &Target::position)
        .field("velocity", &Target::velocity)
        .field("altitude_m", &Target::altitude_m)
        .field("timestamp_s", &Target::timestamp_s);

    value_object<ThreatZone>("ThreatZone")
        .field("target_id", &ThreatZone::target_id)
        .field("cone_polygon", &ThreatZone::cone_polygon)
        .field("eta_seconds", &ThreatZone::eta_seconds)
        .field("certainty_probability", &ThreatZone::certainty_probability);

    register_vector<GeoPoint>("VectorGeoPoint");

    class_<TrajectoryEngine>("TrajectoryEngine")
        .constructor<>()
        .function("computeThreatZone", &TrajectoryEngine::computeThreatZone)
        .function("projectPosition", &TrajectoryEngine::projectPosition)
        .function("haversineDistance", &TrajectoryEngine::haversineDistance)
        .function("computeETA", &TrajectoryEngine::computeETA);

    function("computeConeJSON", &computeConeJSON);
}
