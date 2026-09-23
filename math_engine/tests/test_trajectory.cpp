#include <iostream>
#include <cmath>
#include "../src/trajectory.hpp"

#define ASSERT(condition, message) \
    do { \
        if (!(condition)) { \
            std::cerr << "Assertion `" #condition "` failed in " << __FILE__ \
                      << " line " << __LINE__ << ": " << message << std::endl; \
            std::exit(EXIT_FAILURE); \
        } \
    } while (false)

void test_haversine() {
    TrajectoryEngine engine;
    GeoPoint kyiv{50.45, 30.52};
    GeoPoint vinnytsia{49.23, 28.47};
    double dist = engine.haversineDistance(kyiv, vinnytsia);
    
    // Distance should be roughly 213,000 meters (+- 5%)
    ASSERT(dist > 202000.0 && dist < 224000.0, "Haversine distance failed");
    std::cout << "test_haversine PASSED\n";
}

void test_projectPosition() {
    TrajectoryEngine engine;
    GeoPoint origin{49.23, 28.46}; // Vinnytsia
    // Move east (vx = 100, vy = 0) for 10s -> 1000m
    GeoPoint projected = engine.projectPosition(origin, 100.0, 0.0, 10.0);
    
    ASSERT(std::abs(projected.lat - origin.lat) < 1e-5, "Latitude changed unexpectedly");
    ASSERT(projected.lon > origin.lon, "Longitude did not increase as expected moving east");
    
    // Check distance back to origin
    double dist = engine.haversineDistance(origin, projected);
    ASSERT(std::abs(dist - 1000.0) < 10.0, "Projected distance is incorrect");
    
    std::cout << "test_projectPosition PASSED\n";
}

void test_computeThreatZone() {
    TrajectoryEngine engine;
    Target target;
    target.id = "UFO-1";
    target.position = {50.0, 30.0};
    target.velocity = {100.0, 100.0}; // Northeast
    target.altitude_m = 5000.0;
    target.timestamp_s = 0.0;

    int steps = 10;
    ThreatZone tz = engine.computeThreatZone(target, 60.0, steps);
    
    ASSERT(tz.target_id == "UFO-1", "ThreatZone target ID mismatch");
    ASSERT(tz.eta_seconds == 60.0, "ETA mismatch");
    ASSERT(tz.cone_polygon.size() == static_cast<size_t>(steps * 2 + 3), "Polygon size incorrect");
    
    // Check if polygon is closed
    auto first = tz.cone_polygon.front();
    auto last = tz.cone_polygon.back();
    ASSERT(std::abs(first.lat - last.lat) < 1e-9 && std::abs(first.lon - last.lon) < 1e-9, "Polygon not closed");

    std::cout << "test_computeThreatZone PASSED\n";
}

void test_computeETA() {
    TrajectoryEngine engine;
    GeoPoint cur{50.0, 30.0};
    GeoPoint dest{51.0, 30.0}; // North of current
    Velocity vel{0.0, 0.0}; // Stationary
    
    double eta = engine.computeETA(cur, dest, vel);
    ASSERT(eta == -1.0, "ETA should be -1 for stationary target");
    
    // Moving towards destination
    Velocity vel_north{0.0, 100.0}; // 100 m/s North
    double eta2 = engine.computeETA(cur, dest, vel_north);
    ASSERT(eta2 > 0.0, "ETA should be positive for target moving towards destination");

    std::cout << "test_computeETA PASSED\n";
}

int main() {
    std::cout << "Running TrajectoryEngine Tests...\n";
    test_haversine();
    test_projectPosition();
    test_computeThreatZone();
    test_computeETA();
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
