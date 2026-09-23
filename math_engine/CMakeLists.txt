cmake_minimum_required(VERSION 3.20)
project(airradar_math CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(src)

# Shared library target
add_library(airradar_math SHARED src/trajectory.cpp)

# Test executable target
add_executable(airradar_tests tests/test_trajectory.cpp src/trajectory.cpp)
