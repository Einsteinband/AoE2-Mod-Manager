// Windows release 下不弹控制台
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aoe2_mod_manager_lib::run()
}
